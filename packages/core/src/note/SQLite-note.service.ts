import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import {
  and,
  or,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import { NoteService } from "./note.service"

// The three note tables have different shapes, so the union selects the shared
// columns and tags each row with its kind. `reference` is NULL for kinds that
// do not have one.
interface NoteRow {
  readonly id: string
  readonly type: Note.Kind
  readonly title: string
  readonly content: string
  readonly reference: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

const toInfo = (row: NoteRow): Note.Info => {
  switch (row.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: row.id as FleetingNote.ID,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "literature":
      return {
        type: "literature",
        id: row.id as LiteratureNote.ID,
        title: row.title,
        content: row.content,
        reference: row.reference ?? "",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "permanent":
      return {
        type: "permanent",
        id: row.id as PermanentNote.ID,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
  }
}

// Newest first, then kind and id. Ids are only unique within their own table,
// so the tie-breaker must include the kind as well.
const listOrder = sql`updated_at DESC, type ASC, id ASC`

// Search bounds keep a caller-supplied query and limit from growing the work
// or response without bound.
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const MAX_SEARCH_TOKENS = 16
const SEARCH_FIELDS: ReadonlyArray<Note.SearchField> = ["title", "content", "reference"]

// Title hits are the strongest signal, references next, and body text is the
// broadest signal. Each term contributes at most once per field, so repeating
// a word in a long note cannot outrank a precise title.
const TITLE_WEIGHT = 5
const REFERENCE_WEIGHT = 3
const CONTENT_WEIGHT = 1

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

// SQLite's `lower` is ASCII-only. Mirroring that rule in JavaScript keeps the
// scoring and matching semantics predictable: ASCII case is ignored, while
// non-ASCII text is matched as written.
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

const tokenize = (query: string): ReadonlyArray<string> => {
  const tokens = asciiLower(query).match(TOKEN_PATTERN) ?? []
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS)
}

const effectiveSearchLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT
  }

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)))
}

const contains = (column: SQLWrapper, token: string): SQL<boolean> =>
  sql<boolean>`instr(lower(coalesce(${column}, '')), ${token}) > 0`

interface SearchTable extends AnySQLiteTable {
  readonly id: AnyColumn
  readonly title: AnyColumn
  readonly content: AnyColumn
  readonly createdAt: AnyColumn
  readonly updatedAt: AnyColumn
}

interface SearchRow extends NoteRow {
  readonly score: number
}

// Builds one kind's candidate query. Search fields are selected explicitly so
// callers can search titles only, content only, or any combination.
const buildSearchQuery = (
  db: typeof NoteDatabaseService.Service,
  input: {
    readonly kind: Note.Kind
    readonly table: SearchTable
    /** A real reference column, or the SQL NULL literal for kinds without one. */
    readonly reference: SQLWrapper
    readonly tokens: ReadonlyArray<string>
    readonly fields: ReadonlySet<Note.SearchField>
  },
) => {
  const { kind, table, reference, tokens, fields } = input

  const textCondition = and(
    ...tokens.map((token) => {
      const parts: Array<SQL<boolean>> = []

      if (fields.has("title")) {
        parts.push(contains(table.title, token))
      }
      if (fields.has("content")) {
        parts.push(contains(table.content, token))
      }
      if (fields.has("reference")) {
        parts.push(contains(reference, token))
      }

      return or(...parts)!
    }),
  )!

  const score = tokens
    .map((token) => {
      const parts: Array<SQL<number>> = []

      if (fields.has("title")) {
        parts.push(
          sql<number>`(instr(lower(${table.title}), ${token}) > 0) * ${TITLE_WEIGHT}`,
        )
      }
      if (fields.has("reference")) {
        parts.push(
          sql<number>`(instr(lower(coalesce(${reference}, '')), ${token}) > 0) * ${REFERENCE_WEIGHT}`,
        )
      }
      if (fields.has("content")) {
        parts.push(
          sql<number>`(instr(lower(${table.content}), ${token}) > 0) * ${CONTENT_WEIGHT}`,
        )
      }

      return parts.reduce<SQL<number>>(
        (total, part) => sql<number>`${total} + ${part}`,
        sql<number>`0`,
      )
    })
    .reduce<SQL<number>>((total, part) => sql<number>`${total} + ${part}`, sql<number>`0`)

  return db
    .select({
      id: sql<string>`${table.id}`.as("id"),
      type: sql<Note.Kind>`'${sql.raw(kind)}'`.as("type"),
      title: sql<string>`${table.title}`.as("title"),
      content: sql<string>`${table.content}`.as("content"),
      reference: sql<string | null>`${reference}`.as("reference"),
      createdAt: sql<number>`${table.createdAt}`.as("created_at"),
      updatedAt: sql<number>`${table.updatedAt}`.as("updated_at"),
      score: score.as("score"),
    })
    .from(table)
    .where(textCondition)
}

const searchRows = (
  db: typeof NoteDatabaseService.Service,
  input: Note.SearchInput,
): Effect.Effect<ReadonlyArray<Note.Info>> =>
  Effect.gen(function* () {
    const tokens = tokenize(input.query)
    const limit = effectiveSearchLimit(input.limit)
    const fields = new Set<Note.SearchField>(input.fields ?? SEARCH_FIELDS)
    const kinds = new Set<Note.Kind>(
      input.kinds ?? ["fleeting", "literature", "permanent"],
    )

    if (tokens.length === 0 || fields.size === 0 || kinds.size === 0) {
      return []
    }

    const queries: Array<ReturnType<typeof buildSearchQuery>> = []

    if (kinds.has("fleeting")) {
      queries.push(
        buildSearchQuery(db, {
          kind: "fleeting",
          table: FleetingNoteTable,
          reference: sql<string | null>`NULL`,
          tokens,
          fields,
        }),
      )
    }
    if (kinds.has("literature")) {
      queries.push(
        buildSearchQuery(db, {
          kind: "literature",
          table: LiteratureNoteTable,
          reference: LiteratureNoteTable.reference,
          tokens,
          fields,
        }),
      )
    }
    if (kinds.has("permanent")) {
      queries.push(
        buildSearchQuery(db, {
          kind: "permanent",
          table: PermanentNoteTable,
          reference: sql<string | null>`NULL`,
          tokens,
          fields,
        }),
      )
    }

    // Query each kind separately instead of building one UNION. The global top
    // `limit` results contain at most `limit` rows from any one kind, so
    // `limit + 1` rows per kind is enough to rank globally while keeping every
    // statement small.
    const rows: Array<SearchRow> = []
    for (const query of queries) {
      const kindRows = (yield* query
        .orderBy(sql`score DESC, updated_at DESC, type ASC, id ASC`)
        .limit(limit + 1)) as ReadonlyArray<SearchRow>
      rows.push(...kindRows)
    }

    rows.sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt - left.updatedAt ||
        (left.type < right.type ? -1 : left.type > right.type ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )

    return rows.slice(0, limit).map(toInfo)
  }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))

const listQuery = (db: typeof NoteDatabaseService.Service) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      content: FleetingNoteTable.content,
      reference: sql<string | null>`NULL`.as("reference"),
      createdAt: FleetingNoteTable.createdAt,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          content: LiteratureNoteTable.content,
          reference: LiteratureNoteTable.reference,
          createdAt: LiteratureNoteTable.createdAt,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          content: PermanentNoteTable.content,
          reference: sql<string | null>`NULL`.as("reference"),
          createdAt: PermanentNoteTable.createdAt,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable),
    )
    .orderBy(listOrder)

const listTitlesQuery = (db: typeof NoteDatabaseService.Service) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable),
    )
    .orderBy(listOrder)

// Reads all three note tables directly. It deliberately does not depend on the
// per-kind note services: the database is the only dependency, and each query
// is a single UNION ALL statement.
export const SQLiteNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService

    return NoteService.of({
      list: (_input) => Effect.gen(function* () {
        const rows = yield* listQuery(db)
        return rows.map(toInfo)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      listTitles: (_input) => Effect.gen(function* () {
        const rows = yield* listTitlesQuery(db)
        return rows.map(({ id, type, title }) => ({ id, type, title }))
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      search: (input) => searchRows(db, input),
    })
  }),
)
