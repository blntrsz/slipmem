import type { Note } from "@slipmem/schemas/note"
import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer } from "effect"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { MarkdownError, markdownError } from "./errors.js"
import { readNoteFile } from "./paths.js"
import {
  MarkdownNoteRepository,
} from "./repository.js"
import { defaultIndexCacheDirectory } from "./root.js"

export const INDEX_SCHEMA_VERSION = 1
export const INDEX_FILENAME = "index.sqlite"
export const DEFAULT_TOPIC_LIMIT = 50
export const MAX_TOPIC_LIMIT = 200
export const MAX_SEARCH_QUERY_LENGTH = 512
export const MAX_SEARCH_TOKENS = 16

const DEFAULT_SEARCH_LIMIT = Markdown.DEFAULT_SEARCH_LIMIT
const MAX_SEARCH_LIMIT = Markdown.MAX_SEARCH_LIMIT
const SEARCH_FIELDS: ReadonlyArray<Note.SearchField> = [
  "title",
  "content",
  "reference",
]
const NOTE_KINDS: ReadonlyArray<Note.Kind> = [
  "fleeting",
  "literature",
  "permanent",
]

export type SearchIndexMode = "fts5" | "linear"

export interface MarkdownSearchInput {
  readonly query: string
  readonly fields?: ReadonlyArray<Note.SearchField>
  /** Alias for the note type filter; matches `Note.SearchInput.kinds`. */
  readonly kinds?: ReadonlyArray<Note.Kind>
  readonly topic?: string
  readonly limit?: number
}

export interface MarkdownSearchHit {
  readonly note: Note.Info
  readonly id: string
  readonly path: string
  readonly score: number
}

export interface TopicSummary {
  readonly topic: string
  readonly noteCount: number
}

export interface ListTopicsInput {
  readonly query?: string
  readonly limit?: number
}

export interface IndexRefreshStats {
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly unchanged: number
  readonly invalid: number
  readonly mode: SearchIndexMode
}

export interface IndexSnapshotEntry {
  readonly id: string
  readonly path: string
  readonly contentHash: string
  readonly mtimeMs: number
  readonly size: number
}

export interface MarkdownSearchIndexStatus {
  readonly root: string
  readonly path: string
  readonly schemaVersion: number
  readonly mode: SearchIndexMode
  readonly noteCount: number
}

export interface MarkdownSearchIndexConfig {
  readonly root: string
  /** Exact directory for `index.sqlite`; defaults to the per-root XDG cache. */
  readonly cacheDir?: string
  /** Test/diagnostic hook that selects the bounded linear scan. */
  readonly forceLinearFallback?: boolean
}

export interface MarkdownSearchIndexShape {
  readonly root: string
  readonly path: string
  readonly mode: SearchIndexMode
  readonly refresh: () => Effect.Effect<IndexRefreshStats, MarkdownError>
  readonly rebuild: () => Effect.Effect<IndexRefreshStats, MarkdownError>
  readonly clear: () => Effect.Effect<void, MarkdownError>
  readonly search: (
    input: MarkdownSearchInput,
  ) => Effect.Effect<ReadonlyArray<MarkdownSearchHit>, MarkdownError>
  readonly searchNotes: (
    input: MarkdownSearchInput,
  ) => Effect.Effect<ReadonlyArray<Note.Info>, MarkdownError>
  readonly listTopics: (
    input?: ListTopicsInput,
  ) => Effect.Effect<ReadonlyArray<TopicSummary>, MarkdownError>
  readonly snapshot: () => Effect.Effect<ReadonlyArray<IndexSnapshotEntry>, MarkdownError>
  readonly status: () => Effect.Effect<MarkdownSearchIndexStatus, MarkdownError>
  readonly close: () => Effect.Effect<void>
}

export class MarkdownSearchIndex extends Context.Service<
  MarkdownSearchIndex,
  MarkdownSearchIndexShape
>()("@slipmem/core/MarkdownSearchIndex") {}

interface NoteRow {
  readonly id: string
  readonly path: string
  readonly type: string
  readonly title: string
  readonly body: string
  readonly reference: string | null
  readonly topics: string
  readonly created_at: number
  readonly updated_at: number
  readonly mtime_ms: number
  readonly size: number
  readonly content_hash: string
}

interface SearchRow extends NoteRow {
  readonly rank: number
}

const indexError = (path: string, message: string): MarkdownError =>
  markdownError({ area: "index", code: "index-error", path, message })

const indexPath = (config: MarkdownSearchIndexConfig): string =>
  join(
    resolve(config.cacheDir ?? defaultIndexCacheDirectory(config.root)),
    INDEX_FILENAME,
  )

const ensureUserOnlyDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    chmodSync(path, 0o700)
  } catch {
    // The directory may be owned by a different user or on a filesystem that
    // does not support chmod. The per-user XDG location is still the default.
  }
}

const openDatabase = (root: string, path: string): Database => {
  try {
    ensureUserOnlyDirectory(resolve(path, ".."))
    const db = new Database(path, { create: true, readwrite: true })
    db.exec("PRAGMA busy_timeout = 2000;")
    try {
      chmodSync(path, 0o600)
    } catch {
      // Best effort.
    }
    return db
  } catch (cause) {
    throw indexError(
      root,
      `Could not open the search index at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

const createSchema = (db: Database, forceLinearFallback: boolean): boolean => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      reference TEXT,
      topics TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
  `)

  const version = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'")
    .get()?.value

  if (version !== undefined && version !== String(INDEX_SCHEMA_VERSION)) {
    db.exec("DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS notes;")
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        reference TEXT,
        topics TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
    `)
  }

  let ftsAvailable = false
  if (!forceLinearFallback) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          reference,
          topics,
          tokenize = 'unicode61'
        );
      `)
      ftsAvailable = true
    } catch {
      // FTS5 is an optional runtime capability. The notes table remains valid
      // and every search falls back to a bounded linear scan.
      ftsAvailable = false
    }
  }

  db.query<never, [string, string]>(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
  ).run("schema", String(INDEX_SCHEMA_VERSION))
  db.query<never, [string, string]>(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
  ).run("fts", ftsAvailable ? "1" : "0")

  return ftsAvailable
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const byNewest = (
  left: { readonly updatedAt: number; readonly id: string },
  right: { readonly updatedAt: number; readonly id: string },
): number =>
  right.updatedAt - left.updatedAt ||
  compareText(left.id, right.id)

const topicText = (topics: ReadonlyArray<string>): string =>
  topics.length === 0 ? "" : ` ${topics.join(" ")} `

const parseTopics = (topics: string): ReadonlyArray<string> =>
  topics.length === 0 ? [] : topics.trim().split(/\s+/)

const rowToInfo = (row: NoteRow): Note.Info => {
  switch (row.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: row.id as never,
        title: row.title,
        content: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    case "literature":
      return {
        type: "literature",
        id: row.id as never,
        title: row.title,
        content: row.body,
        reference: row.reference ?? "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    case "permanent":
      return {
        type: "permanent",
        id: row.id as never,
        title: row.title,
        content: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    default:
      throw new Error(`Unknown indexed note type: ${row.type}`)
  }
}

const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

const tokenize = (query: string): ReadonlyArray<string> => {
  const tokens = asciiLower(query).match(TOKEN_PATTERN) ?? []
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS)
}

const effectiveLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)))
}

const effectiveTopicLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TOPIC_LIMIT
  }
  return Math.max(1, Math.min(MAX_TOPIC_LIMIT, Math.trunc(limit)))
}

const matches = (value: string, token: string): boolean =>
  asciiLower(value).includes(token)

const MATCH_WEIGHTS = {
  title: 5,
  content: 1,
  reference: 3,
} as const

const linearScore = (
  row: NoteRow,
  tokens: ReadonlyArray<string>,
  fields: ReadonlySet<Note.SearchField>,
): number => {
  let score = 0
  for (const token of tokens) {
    if (fields.has("title") && matches(row.title, token)) {
      score += MATCH_WEIGHTS.title
    }
    if (fields.has("content") && matches(row.body, token)) {
      score += MATCH_WEIGHTS.content
    }
    if (
      fields.has("reference") &&
      row.reference !== null &&
      matches(row.reference, token)
    ) {
      score += MATCH_WEIGHTS.reference
    }
  }
  return score
}

const ftsMatchExpression = (
  tokens: ReadonlyArray<string>,
  fields: ReadonlySet<Note.SearchField>,
): string => {
  const columns: string[] = []
  if (fields.has("title")) {
    columns.push("title")
  }
  if (fields.has("content")) {
    columns.push("body")
  }
  if (fields.has("reference")) {
    columns.push("reference")
  }

  return tokens
    .map((token) => {
      const escaped = token.replace(/"/g, '""')
      const terms = columns.map((column) => `${column} : "${escaped}"`)
      return `(${terms.join(" OR ")})`
    })
    .join(" AND ")
}

const kindFilters = (kinds: ReadonlySet<Note.Kind>): {
  readonly sql: string
  readonly values: ReadonlyArray<SQLQueryBindings>
} => {
  const values = [...kinds]
  return {
    sql: values.map(() => "?").join(", "),
    values,
  }
}

/**
 * Builds the disposable index. The SQLite file contains derived data only; it
 * is safe to delete at any time and `rebuild` restores the same notes and
 * search results from Markdown files.
 */
export const makeMarkdownSearchIndex = (
  config: MarkdownSearchIndexConfig,
): Effect.Effect<MarkdownSearchIndexShape, MarkdownError> =>
  Effect.gen(function* () {
    const root = resolve(config.root)
    const path = indexPath(config)
    const database = yield* Effect.try({
      try: () => openDatabase(root, path),
      catch: (cause) =>
        cause instanceof MarkdownError
          ? cause
          : indexError(
              root,
              `Could not open the search index: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
    })
    const ftsAvailable = yield* Effect.try({
      try: () => {
        try {
          return createSchema(database, config.forceLinearFallback === true)
        } catch (cause) {
          database.close()
          throw cause
        }
      },
      catch: (cause) =>
        cause instanceof MarkdownError
          ? cause
          : indexError(
              path,
              `Could not initialize the search index: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
    })
    const mode: SearchIndexMode = ftsAvailable ? "fts5" : "linear"

    const scoped = <A>(
      operation: string,
      run: () => A,
    ): Effect.Effect<A, MarkdownError> =>
      Effect.try({
        try: run,
        catch: (cause) =>
          cause instanceof MarkdownError
            ? cause
            : indexError(
                path,
                `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
      })

    const deleteRow = (id: string): void => {
      database.query<never, [string]>("DELETE FROM notes WHERE id = ?1").run(id)
      if (ftsAvailable) {
        database
          .query<never, [string]>("DELETE FROM notes_fts WHERE id = ?1")
          .run(id)
      }
    }

    const upsertRow = (row: NoteRow): void => {
      database
        .query<never, [string, string, string, string, string, string | null, string, number, number, number, number, string]>(
          `INSERT INTO notes
            (id, path, type, title, body, reference, topics, created_at, updated_at, mtime_ms, size, content_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             type = excluded.type,
             title = excluded.title,
             body = excluded.body,
             reference = excluded.reference,
             topics = excluded.topics,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             content_hash = excluded.content_hash`,
        )
        .run(
          row.id,
          row.path,
          row.type,
          row.title,
          row.body,
          row.reference,
          row.topics,
          row.created_at,
          row.updated_at,
          row.mtime_ms,
          row.size,
          row.content_hash,
        )

      if (ftsAvailable) {
        database
          .query<never, [string]>("DELETE FROM notes_fts WHERE id = ?1")
          .run(row.id)
        database
          .query<never, [string, string, string, string | null, string]>(
            "INSERT INTO notes_fts (id, title, body, reference, topics) VALUES (?1, ?2, ?3, ?4, ?5)",
          )
          .run(row.id, row.title, row.body, row.reference, row.topics)
      }
    }

    const rowFromNote = (note: {
      readonly id: string
      readonly path: string
      readonly metadata: Markdown.NoteMetadata
      readonly body: string
      readonly contentHash: string
      readonly size: number
      readonly mtimeMs: number
      readonly info: Note.Info
    }): NoteRow => ({
      id: note.id,
      path: note.path,
      type: note.metadata.type,
      title: note.metadata.title,
      body: note.body,
      reference: note.metadata.reference ?? null,
      topics: topicText(note.metadata.topics ?? []),
      created_at: note.info.createdAt,
      updated_at: note.info.updatedAt,
      mtime_ms: note.mtimeMs,
      size: note.size,
      content_hash: note.contentHash,
    })

    const repairFts = (): void => {
      if (!ftsAvailable) {
        return
      }

      const noteCount = database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notes")
        .get()!.count
      const ftsCount = database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notes_fts")
        .get()!.count

      if (noteCount === ftsCount) {
        return
      }

      database.exec("DELETE FROM notes_fts;")
      const rows = database
        .query<NoteRow, []>("SELECT * FROM notes")
        .all()
      for (const row of rows) {
        database
          .query<never, [string, string, string, string | null, string]>(
            "INSERT INTO notes_fts (id, title, body, reference, topics) VALUES (?1, ?2, ?3, ?4, ?5)",
          )
          .run(row.id, row.title, row.body, row.reference, row.topics)
      }
    }

    const refresh = (): Effect.Effect<IndexRefreshStats, MarkdownError> =>
      Effect.gen(function* () {
        const entries = yield* Effect.try({
          try: () => {
            const names = readdirSync(root).sort()
            return names.map((name) => {
              const filePath = join(root, name)
              return { name, path: filePath, stats: lstatSync(filePath) }
            })
          },
          catch: (cause) =>
            indexError(
              root,
              `Could not read the note root for indexing: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        })

        const existing = new Map(
          (yield* scoped("Reading indexed notes", () =>
            database.query<NoteRow, []>("SELECT * FROM notes").all(),
          )).map((row) => [row.id, row]),
        )
        const seen = new Set<string>()
        let added = 0
        let updated = 0
        let unchanged = 0
        let invalid = 0

        for (const entry of entries) {
          const id = Markdown.noteIdFromFilename(entry.name)
          if (id === null || entry.stats.isSymbolicLink() || !entry.stats.isFile()) {
            continue
          }

          seen.add(id)
          const previous = existing.get(id)
          if (
            previous !== undefined &&
            previous.path === entry.path &&
            previous.mtime_ms === entry.stats.mtimeMs &&
            previous.size === entry.stats.size
          ) {
            unchanged++
            continue
          }

          const result = yield* readNoteFile(root, id).pipe(
            Effect.match({
              onFailure: () => ({ note: null }),
              onSuccess: (note) => ({ note }),
            }),
          )

          if (result.note === null) {
            invalid++
            if (previous !== undefined) {
              yield* scoped("Removing an invalid note from the index", () =>
                database.transaction(() => deleteRow(id))(),
              )
            }
            continue
          }

          yield* scoped("Updating an indexed note", () =>
            database.transaction(() => upsertRow(rowFromNote(result.note!)))(),
          )
          if (previous === undefined) {
            added++
          } else {
            updated++
          }
        }

        let removed = 0
        for (const id of existing.keys()) {
          if (!seen.has(id)) {
            yield* scoped("Removing a deleted note from the index", () =>
              database.transaction(() => deleteRow(id))(),
            )
            removed++
          }
        }

        yield* scoped("Repairing the FTS table", () =>
          database.transaction(() => repairFts())(),
        )

        return { added, updated, removed, unchanged, invalid, mode }
      })

    const rebuild = (): Effect.Effect<IndexRefreshStats, MarkdownError> =>
      scoped("Rebuilding the search index", () => {
        database.transaction(() => {
          database.exec("DELETE FROM notes;")
          if (ftsAvailable) {
            database.exec("DELETE FROM notes_fts;")
          }
        })()
      }).pipe(Effect.flatMap(() => refresh()))

    const clear = (): Effect.Effect<void, MarkdownError> =>
      scoped("Clearing the search index", () => {
        database.transaction(() => {
          database.exec("DELETE FROM notes;")
          if (ftsAvailable) {
            database.exec("DELETE FROM notes_fts;")
          }
        })()
      })

    const normalizeSearch = (
      input: MarkdownSearchInput,
    ): Effect.Effect<
      {
        tokens: ReadonlyArray<string>
        fields: ReadonlySet<Note.SearchField>
        kinds: ReadonlySet<Note.Kind>
        topic: string | undefined
        limit: number
      },
      MarkdownError
    > =>
      Effect.gen(function* () {
        const query = input.query.trim()
        if (query.length > MAX_SEARCH_QUERY_LENGTH) {
          return yield* Effect.fail(
            indexError(
              path,
              `Search queries must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer.`,
            ),
          )
        }

        const topic =
          input.topic === undefined ? undefined : Markdown.slugifyTopic(input.topic)
        if (input.topic !== undefined && topic === "") {
          return yield* Effect.fail(
            markdownError({
              area: "metadata",
              code: "invalid-topic",
              path: root,
              field: "topic",
              message: `Topic '${input.topic}' does not normalize to a usable slug.`,
            }),
          )
        }

        return {
          tokens: tokenize(query),
          fields: new Set(input.fields ?? SEARCH_FIELDS),
          kinds: new Set(input.kinds ?? NOTE_KINDS),
          topic,
          limit: effectiveLimit(input.limit),
        }
      })

    const linearSearch = (
      input: MarkdownSearchInput,
      fields: ReadonlySet<Note.SearchField>,
      kinds: ReadonlySet<Note.Kind>,
      topic: string | undefined,
      tokens: ReadonlyArray<string>,
      limit: number,
    ): ReadonlyArray<MarkdownSearchHit> =>
      database
        .query<NoteRow, []>("SELECT * FROM notes")
        .all()
        .filter((row) => kinds.has(row.type as Note.Kind))
        .filter((row) => topic === undefined || parseTopics(row.topics).includes(topic))
        .filter((row) =>
          tokens.every((token) => linearScore(row, [token], fields) > 0),
        )
        .map((row) => ({ row, score: linearScore(row, tokens, fields) }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            byNewest(
              { updatedAt: left.row.updated_at, id: left.row.id },
              { updatedAt: right.row.updated_at, id: right.row.id },
            ),
        )
        .slice(0, limit)
        .map(({ row, score }) => ({
          note: rowToInfo(row),
          id: row.id,
          path: row.path,
          score,
        }))

    const ftsSearch = (
      fields: ReadonlySet<Note.SearchField>,
      kinds: ReadonlySet<Note.Kind>,
      topic: string | undefined,
      tokens: ReadonlyArray<string>,
      limit: number,
    ): ReadonlyArray<MarkdownSearchHit> => {
      const match = ftsMatchExpression(tokens, fields)
      if (match.length === 0) {
        return []
      }

      const kind = kindFilters(kinds)
      const values: SQLQueryBindings[] = [match, ...kind.values]
      let topicClause = ""
      if (topic !== undefined) {
        topicClause = "AND instr(n.topics, ?) > 0"
        values.push(topicText([topic]))
      }
      values.push(limit)

      const rows = database
        .query<SearchRow, SQLQueryBindings[]>(
          `SELECT n.*, bm25(notes_fts, 0.0, 5.0, 1.0, 3.0, 2.0) AS rank
             FROM notes_fts
             JOIN notes n ON n.id = notes_fts.id
            WHERE notes_fts MATCH ?
              AND n.type IN (${kind.sql})
              ${topicClause}
            ORDER BY rank ASC, n.updated_at DESC, n.id ASC
            LIMIT ?`,
        )
        .all(...values)

      return rows.map((row) => ({
        note: rowToInfo(row),
        id: row.id,
        path: row.path,
        score: -row.rank,
      }))
    }

    const search = (
      input: MarkdownSearchInput,
    ): Effect.Effect<ReadonlyArray<MarkdownSearchHit>, MarkdownError> =>
      Effect.gen(function* () {
        const normalized = yield* normalizeSearch(input)
        if (
          normalized.tokens.length === 0 ||
          normalized.fields.size === 0 ||
          normalized.kinds.size === 0
        ) {
          return []
        }

        return yield* scoped("Searching the index", () =>
          mode === "fts5"
            ? ftsSearch(
                normalized.fields,
                normalized.kinds,
                normalized.topic,
                normalized.tokens,
                normalized.limit,
              )
            : linearSearch(
                input,
                normalized.fields,
                normalized.kinds,
                normalized.topic,
                normalized.tokens,
                normalized.limit,
              ),
        )
      })

    const listTopics = (
      input: ListTopicsInput = {},
    ): Effect.Effect<ReadonlyArray<TopicSummary>, MarkdownError> =>
      Effect.gen(function* () {
        const limit = effectiveTopicLimit(input.limit)
        const query =
          input.query === undefined ? "" : Markdown.slugifyTopic(input.query)
        if (input.query !== undefined && query === "") {
          return yield* Effect.fail(
            markdownError({
              area: "metadata",
              code: "invalid-topic",
              path: root,
              field: "topic",
              message: `Topic query '${input.query}' does not normalize to a usable slug.`,
            }),
          )
        }

        const rows = yield* scoped("Listing topics", () =>
          database
            .query<{ topics: string }, []>("SELECT topics FROM notes")
            .all(),
        )
        const counts = new Map<string, number>()
        for (const row of rows) {
          for (const topic of parseTopics(row.topics)) {
            if (query.length === 0 || topic.includes(query)) {
              counts.set(topic, (counts.get(topic) ?? 0) + 1)
            }
          }
        }

        return [...counts.entries()]
          .map(([topic, noteCount]) => ({ topic, noteCount }))
          .sort(
            (left, right) =>
              right.noteCount - left.noteCount ||
              compareText(left.topic, right.topic),
          )
          .slice(0, limit)
      })

    const snapshot = (): Effect.Effect<ReadonlyArray<IndexSnapshotEntry>, MarkdownError> =>
      scoped("Reading the index snapshot", () =>
        database
          .query<NoteRow, []>("SELECT * FROM notes")
          .all()
          .map((row) => ({
            id: row.id,
            path: row.path,
            contentHash: row.content_hash,
            mtimeMs: row.mtime_ms,
            size: row.size,
          })),
      )

    const status = (): Effect.Effect<MarkdownSearchIndexStatus, MarkdownError> =>
      scoped("Reading index status", () => ({
        root,
        path,
        schemaVersion: INDEX_SCHEMA_VERSION,
        mode,
        noteCount: database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notes")
          .get()!.count,
      }))

    return {
      root,
      path,
      mode,
      refresh,
      rebuild,
      clear,
      search,
      searchNotes: (input) =>
        search(input).pipe(
          Effect.map((hits) => hits.map((hit) => hit.note)),
        ),
      listTopics,
      snapshot,
      status,
      close: () => Effect.sync(() => database.close()),
    }
  })

/** Scoped Layer that closes the SQLite handle when the scope ends. */
export const MarkdownSearchIndexLive = (
  config: MarkdownSearchIndexConfig,
): Layer.Layer<MarkdownSearchIndex, MarkdownError> =>
  Layer.effect(
    MarkdownSearchIndex,
    Effect.acquireRelease(makeMarkdownSearchIndex(config), (index) => index.close()),
  )

/** Convenience wiring for the service graph: the repository supplies the root. */
export const MarkdownSearchIndexFromRepository = (
  options: Omit<MarkdownSearchIndexConfig, "root"> = {},
): Layer.Layer<
  MarkdownSearchIndex,
  MarkdownError,
  MarkdownNoteRepository
> =>
  Layer.effect(
    MarkdownSearchIndex,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      return yield* Effect.acquireRelease(
        makeMarkdownSearchIndex({ ...options, root: repository.root }),
        (index) => index.close(),
      )
    }),
  )

export const indexContentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

export const indexExists = (config: MarkdownSearchIndexConfig): boolean =>
  existsSync(indexPath(config))

export const indexDatabasePath = (config: MarkdownSearchIndexConfig): string =>
  indexPath(config)
