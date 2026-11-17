import type { Note } from "@slipmem/schemas/note"
import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer, Option } from "effect"
import {
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { atomicWriteFile } from "./atomic.js"
import { MarkdownError, markdownError } from "./errors.js"
import { renderNoteDocument } from "./frontmatter.js"
import {
  LOCK_FILENAME,
  withRepositoryLock,
  type RepositoryLockOptions,
} from "./lock.js"
import {
  createMarkdownNoteDocument,
  type ParsedMarkdownNote,
} from "./note-document.js"
import {
  listNoteFilenames,
  listRootEntries,
  notePath,
  readNoteFile,
  type RepositoryEntry,
} from "./paths.js"
import {
  defaultBackupDirectory,
  isPathInside,
  rootSymlinkError,
  STATE_DIRECTORY,
} from "./root.js"

export const DEFAULT_LIST_LIMIT = Markdown.DEFAULT_SEARCH_LIMIT

export interface ListMarkdownNotesInput {
  readonly type?: Markdown.NoteType
  /** A topic slug; display forms are normalized with the shared pipeline. */
  readonly topic?: string
  readonly limit?: number
}

export interface MarkdownNoteTitle {
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly updatedAt: number
}

export interface CreateMarkdownNoteInput {
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly topics?: ReadonlyArray<string>
  readonly provenance?: Markdown.Provenance
  readonly legacyId?: string
  readonly aliases?: ReadonlyArray<string>
  /** Additional frontmatter fields, preserved for compatibility/migration. */
  readonly unknown?: Readonly<Record<string, unknown>>
  /** Creation time for a normal write is the repository clock. */
  readonly createdAt?: number
  readonly updatedAt?: number
}

export interface UpdateMarkdownNoteInput {
  readonly id: string
  readonly type?: Markdown.NoteType
  readonly title?: string
  readonly content?: string
  /** `null` removes the reference; `undefined` preserves it. */
  readonly reference?: string | null
  readonly topics?: ReadonlyArray<string>
  readonly provenance?: Markdown.Provenance
  readonly legacyId?: string
  readonly aliases?: ReadonlyArray<string>
  /** Fields to merge into the preserved unknown frontmatter record. */
  readonly unknown?: Readonly<Record<string, unknown>>
}

export interface DeleteMarkdownNoteResult {
  readonly id: string
  readonly note: ParsedMarkdownNote
  readonly backupPath: string
}

export interface RepositoryScan {
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  readonly invalid: ReadonlyArray<MarkdownError>
  readonly unexpected: ReadonlyArray<RepositoryEntry>
}

export interface MarkdownRepositoryConfig {
  readonly root: string
  /** Injectable for deterministic filenames and tests. */
  readonly now?: () => number
  /** Must be outside the note root. Defaults to the XDG state directory. */
  readonly backupDir?: string
  readonly lock?: RepositoryLockOptions
}

export interface MarkdownNoteRepositoryShape {
  /** Absolute note root. Every file operation is confined to this directory. */
  readonly root: string
  readonly list: (
    input?: ListMarkdownNotesInput,
  ) => Effect.Effect<ReadonlyArray<Note.Info>, MarkdownError>
  readonly listNotes: (
    input?: ListMarkdownNotesInput,
  ) => Effect.Effect<ReadonlyArray<ParsedMarkdownNote>, MarkdownError>
  readonly listTitles: (
    input?: ListMarkdownNotesInput,
  ) => Effect.Effect<ReadonlyArray<MarkdownNoteTitle>, MarkdownError>
  readonly get: (
    id: string,
  ) => Effect.Effect<Option.Option<ParsedMarkdownNote>, MarkdownError>
  readonly getInfo: (
    id: string,
  ) => Effect.Effect<Option.Option<Note.Info>, MarkdownError>
  readonly create: (
    input: CreateMarkdownNoteInput,
  ) => Effect.Effect<ParsedMarkdownNote, MarkdownError>
  readonly update: (
    input: UpdateMarkdownNoteInput,
  ) => Effect.Effect<ParsedMarkdownNote, MarkdownError>
  readonly delete: (
    id: string,
  ) => Effect.Effect<DeleteMarkdownNoteResult, MarkdownError>
  readonly scan: () => Effect.Effect<RepositoryScan, MarkdownError>
}

export class MarkdownNoteRepository extends Context.Service<
  MarkdownNoteRepository,
  MarkdownNoteRepositoryShape
>()("@slipmem/core/MarkdownNoteRepository") {}

const metadataError = (
  path: string,
  code: "blank-title" | "content-empty" | "invalid-topic" | "missing-reference" | "timestamp-invalid",
  field: string,
  message: string,
): MarkdownError =>
  markdownError({ area: "metadata", code, path, field, message })

const repositoryError = (
  path: string,
  code: "repository-root-missing" | "not-found" | "backup-failed" | "write-failed",
  message: string,
): MarkdownError =>
  markdownError({ area: "repository", code, path, message })

const normalizeTitle = (path: string, title: string): Effect.Effect<string, MarkdownError> =>
  Effect.gen(function* () {
    const normalized = title.trim()
    if (normalized.length === 0) {
      return yield* Effect.fail(
        metadataError(path, "blank-title", "title", "Title must not be whitespace."),
      )
    }
    return normalized
  })

const normalizeContent = (
  path: string,
  content: string,
): Effect.Effect<string, MarkdownError> =>
  Effect.gen(function* () {
    const normalized = content.trim()
    if (normalized.length === 0) {
      return yield* Effect.fail(
        metadataError(path, "content-empty", "content", "Note content must not be empty."),
      )
    }
    return normalized
  })

const normalizeTopics = (
  path: string,
  topics: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, MarkdownError> =>
  Effect.gen(function* () {
    if (topics === undefined) {
      return undefined
    }

    const normalized: string[] = []
    for (const topic of topics) {
      const slug = Markdown.slugifyTopic(topic)
      if (slug === "") {
        return yield* Effect.fail(
          metadataError(
            path,
            "invalid-topic",
            "topics",
            `Topic '${topic}' does not normalize to a usable slug.`,
          ),
        )
      }
      if (!normalized.includes(slug)) {
        normalized.push(slug)
      }
    }
    return normalized
  })

const normalizeReference = (reference: string | undefined): string | undefined => {
  if (reference === undefined) {
    return undefined
  }
  const trimmed = reference.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const asListLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT
  }
  return Math.max(1, Math.min(Markdown.MAX_SEARCH_LIMIT, Math.trunc(limit)))
}

const byNewest = (
  left: { readonly updatedAt: number; readonly id: string },
  right: { readonly updatedAt: number; readonly id: string },
): number =>
  right.updatedAt - left.updatedAt ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/**
 * Scans the flat note root. Valid notes become `notes`; note-shaped files that
 * fail the contract become `invalid`; everything else (README, `.gitignore`,
 * `.state/` is skipped) becomes `unexpected` for `check`.
 */
export const scanMarkdownRoot = (
  root: string,
): Effect.Effect<RepositoryScan, MarkdownError> =>
  Effect.gen(function* () {
    const entries = yield* listRootEntries(root)
    const notes: ParsedMarkdownNote[] = []
    const invalid: MarkdownError[] = []
    const unexpected: RepositoryEntry[] = []

    for (const entry of entries) {
      if (entry.name === STATE_DIRECTORY && entry.kind === "directory") {
        continue
      }

      if (!entry.isNoteFilename) {
        unexpected.push(entry)
        continue
      }

      if (entry.kind === "symlink") {
        invalid.push(
          markdownError({
            area: "path",
            code: "symlink",
            path: entry.path,
            message: "Symlinked note files are not allowed.",
          }),
        )
        continue
      }

      if (entry.kind !== "file") {
        invalid.push(
          markdownError({
            area: "path",
            code: "not-found",
            path: entry.path,
            message: "A note filename must be a regular file.",
          }),
        )
        continue
      }

      const result = yield* readNoteFile(
        root,
        Markdown.noteIdFromFilename(entry.name)!,
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ error, note: null }),
          onSuccess: (note) => ({ error: null, note }),
        }),
      )

      if (result.error !== null) {
        invalid.push(result.error)
      } else if (result.note !== null) {
        notes.push(result.note)
      }
    }

    notes.sort((left, right) => byNewest(left.info, right.info))
    return { notes, invalid, unexpected }
  })

type RootStatus = "ok" | "symlink" | "missing"

/**
 * Uses lstat so a note root symlink is reported as such. Following it with
 * stat would either accept an unexpected location or fail later as "missing".
 */
const inspectRoot = (root: string): RootStatus => {
  try {
    const stats = lstatSync(root)
    if (stats.isSymbolicLink()) {
      return "symlink"
    }
    return stats.isDirectory() ? "ok" : "missing"
  } catch {
    return "missing"
  }
}

const assertRoot = (root: string): Effect.Effect<void, MarkdownError> =>
  Effect.sync(() => inspectRoot(root)).pipe(
    Effect.flatMap((status) =>
      status === "ok"
        ? Effect.void
        : Effect.fail(
            status === "symlink"
              ? rootSymlinkError(root)
              : repositoryError(
                  root,
                  "repository-root-missing",
                  `The note root does not exist. Run 'slipmem init' or create ${root}.`,
                ),
          ),
    ),
  )

const isCrossDevice = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "EXDEV"

const ensureBackupDirectory = (root: string, backupDir: string): string => {
  if (isPathInside(backupDir, root)) {
    throw new Error("The backup directory must be outside the note root.")
  }
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  return backupDir
}

const backupNote = (
  root: string,
  note: ParsedMarkdownNote,
  backupDir: string,
  nowMs: number,
): string => {
  ensureBackupDirectory(root, backupDir)
  const stamp = Markdown.toUtcTimestamp(nowMs).filenamePrefix
  const base = `${stamp}-${note.filename}`
  let target = join(backupDir, base)
  for (let suffix = 2; existsSync(target); suffix++) {
    target = join(backupDir, `${stamp}-${base.replace(/\.md$/, "")}-${suffix}.md`)
  }

  try {
    renameSync(note.path, target)
  } catch (cause) {
    if (!isCrossDevice(cause)) {
      throw cause
    }
    copyFileSync(note.path, target)
    try {
      const descriptor = openSync(target, "r")
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      // Best effort; the copy already completed.
    }
    unlinkSync(note.path)
  }

  return target
}

/**
 * Builds the Markdown repository for one root.
 *
 * Mutations take the lock file through `withRepositoryLock`; reads never take
 * it. Every write renders and re-parses the full document before touching the
 * filesystem and uses a same-directory atomic write.
 */
export const makeMarkdownNoteRepository = (
  config: MarkdownRepositoryConfig,
): Effect.Effect<MarkdownNoteRepositoryShape, MarkdownError> =>
  Effect.gen(function* () {
    const root = resolve(config.root)
    const clock = config.now ?? Date.now
    const backupDir = config.backupDir ?? defaultBackupDirectory(root)

    yield* assertRoot(root)

    const listNotes = (
      input: ListMarkdownNotesInput = {},
    ): Effect.Effect<ReadonlyArray<ParsedMarkdownNote>, MarkdownError> =>
      Effect.gen(function* () {
        const topic =
          input.topic === undefined ? undefined : Markdown.slugifyTopic(input.topic)
        if (input.topic !== undefined && topic === "") {
          return yield* Effect.fail(
            metadataError(
              root,
              "invalid-topic",
              "topic",
              `Topic '${input.topic}' does not normalize to a usable slug.`,
            ),
          )
        }

        const scan = yield* scanMarkdownRoot(root)
        return scan.notes
          .filter((note) => input.type === undefined || note.metadata.type === input.type)
          .filter(
            (note) =>
              topic === undefined ||
              (note.metadata.topics ?? []).includes(topic),
          )
          .slice(0, asListLimit(input.limit))
      })

    const get = (
      id: string,
    ): Effect.Effect<Option.Option<ParsedMarkdownNote>, MarkdownError> =>
      readNoteFile(root, id).pipe(
        Effect.map((note) => Option.fromNullishOr(note)),
      )

    const create = (
      input: CreateMarkdownNoteInput,
    ): Effect.Effect<ParsedMarkdownNote, MarkdownError> =>
      Effect.gen(function* () {
        yield* assertRoot(root)
        const title = yield* normalizeTitle(root, input.title)
        const body = yield* normalizeContent(root, input.content)
        const topics = yield* normalizeTopics(root, input.topics)
        const reference = normalizeReference(input.reference)
        const createdAtMs = input.createdAt ?? clock()
        if (!Number.isFinite(createdAtMs)) {
          return yield* Effect.fail(
            metadataError(
              root,
              "timestamp-invalid",
              "createdAt",
              "Creation time must be a finite epoch millisecond value.",
            ),
          )
        }
        const updatedAtMs = input.updatedAt ?? createdAtMs
        if (!Number.isFinite(updatedAtMs)) {
          return yield* Effect.fail(
            metadataError(
              root,
              "timestamp-invalid",
              "updatedAt",
              "Update time must be a finite epoch millisecond value.",
            ),
          )
        }

        return yield* withRepositoryLock(
          root,
          Effect.gen(function* () {
            const taken = new Set(yield* listNoteFilenames(root))

            for (let attempt = 0; attempt < 100; attempt++) {
              const filename = Markdown.noteFilename({
                title,
                createdAt: createdAtMs,
                taken,
              })
              const id = Markdown.noteIdFromFilename(filename)!
              const path = yield* notePath(root, id)
              const metadata: Markdown.NoteMetadata = {
                schema: Markdown.SCHEMA_VERSION,
                id,
                type: input.type,
                title,
                createdAt: Markdown.toUtcTimestamp(createdAtMs).isoTimestamp,
                updatedAt: Markdown.toUtcTimestamp(updatedAtMs).isoTimestamp,
                ...(topics === undefined || topics.length === 0 ? {} : { topics }),
                ...(reference === undefined ? {} : { reference }),
                ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
                ...(input.legacyId === undefined ? {} : { legacyId: input.legacyId }),
                ...(input.aliases === undefined || input.aliases.length === 0
                  ? {}
                  : { aliases: input.aliases }),
              }

              const document = yield* createMarkdownNoteDocument({
                path,
                metadata,
                body,
                unknown: input.unknown ?? {},
              })

              const write = yield* atomicWriteFile(path, renderDocument(document), {
                overwrite: false,
              }).pipe(
                Effect.match({
                  onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                  onSuccess: (result) => ({ _tag: "Right" as const, right: result }),
                }),
              )

              if (write._tag === "Right") {
                const stored = yield* readNoteFile(root, id)
                return stored ?? document
              }

              // A filename collision is the only expected create failure. The
              // next loop iteration keeps the timestamp and adds a suffix.
              if (existsSync(path)) {
                taken.add(filename)
                continue
              }

              return yield* Effect.fail(write.left)
            }

            return yield* Effect.fail(
              repositoryError(
                root,
                "write-failed",
                "Could not allocate a unique note filename after 100 collisions.",
              ),
            )
          }),
          config.lock,
        )
      })

    const update = (
      input: UpdateMarkdownNoteInput,
    ): Effect.Effect<ParsedMarkdownNote, MarkdownError> =>
      withRepositoryLock(
        root,
        Effect.gen(function* () {
          const current = yield* readNoteFile(root, input.id)
          if (current === null) {
            return yield* Effect.fail(
              repositoryError(root, "not-found", `Note '${input.id}' was not found.`),
            )
          }

          const type = input.type ?? current.metadata.type
          const title =
            input.title === undefined
              ? current.metadata.title
              : yield* normalizeTitle(current.path, input.title)
          const body =
            input.content === undefined
              ? current.body
              : yield* normalizeContent(current.path, input.content)
          const topics =
            input.topics === undefined
              ? current.metadata.topics
              : yield* normalizeTopics(current.path, input.topics)
          const reference =
            input.reference === null
              ? undefined
              : input.reference === undefined
                ? current.metadata.reference
                : normalizeReference(input.reference)
          const nowMs = clock()
          const updatedAtMs = Number.isFinite(nowMs)
            ? Math.max(nowMs, current.info.updatedAt, current.info.createdAt)
            : Math.max(current.info.updatedAt, current.info.createdAt)

          const metadata: Markdown.NoteMetadata = {
            schema: Markdown.SCHEMA_VERSION,
            id: current.id,
            type,
            title,
            createdAt: current.metadata.createdAt,
            updatedAt: Markdown.toUtcTimestamp(updatedAtMs).isoTimestamp,
            ...(topics === undefined || topics.length === 0 ? {} : { topics }),
            ...(reference === undefined ? {} : { reference }),
            ...((input.provenance ?? current.metadata.provenance) === undefined
              ? {}
              : { provenance: input.provenance ?? current.metadata.provenance }),
            ...((input.legacyId ?? current.metadata.legacyId) === undefined
              ? {}
              : { legacyId: input.legacyId ?? current.metadata.legacyId }),
            ...((input.aliases ?? current.metadata.aliases) === undefined
              ? {}
              : { aliases: input.aliases ?? current.metadata.aliases }),
          }

          const document = yield* createMarkdownNoteDocument({
            path: current.path,
            metadata,
            body,
            unknown:
              input.unknown === undefined
                ? current.unknown
                : { ...current.unknown, ...input.unknown },
          })

          yield* atomicWriteFile(current.path, renderDocument(document), {
            overwrite: true,
          })

          const stored = yield* readNoteFile(root, current.id)
          return stored ?? document
        }),
        config.lock,
      )

    const remove = (
      id: string,
    ): Effect.Effect<DeleteMarkdownNoteResult, MarkdownError> =>
      withRepositoryLock(
        root,
        Effect.gen(function* () {
          const note = yield* readNoteFile(root, id)
          if (note === null) {
            return yield* Effect.fail(
              repositoryError(root, "not-found", `Note '${id}' was not found.`),
            )
          }

          const target = yield* Effect.try({
            try: () => backupNote(root, note, backupDir, clock()),
            catch: (cause) =>
              repositoryError(
                root,
                "backup-failed",
                `Could not back up the note before deleting it: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          })

          // A successful backup move is the delete. If the backup failed, the
          // original file is still in place.
          return { id, note, backupPath: target }
        }),
        config.lock,
      )

    return {
      root,
      list: (input) =>
        listNotes(input).pipe(
          Effect.map((notes) => notes.map((note) => note.info)),
        ),
      listNotes,
      listTitles: (input) =>
        listNotes(input).pipe(
          Effect.map((notes) =>
            notes.map((note) => ({
              id: note.id,
              type: note.metadata.type,
              title: note.metadata.title,
              updatedAt: note.info.updatedAt,
            })),
          ),
        ),
      get,
      getInfo: (id) => get(id).pipe(Effect.map(Option.map((note) => note.info))),
      create,
      update,
      delete: remove,
      scan: () => scanMarkdownRoot(root),
    }
  })

/** Builds the repository as a Layer for the Effect service graph. */
export const MarkdownNoteRepositoryLive = (
  config: MarkdownRepositoryConfig,
): Layer.Layer<MarkdownNoteRepository, MarkdownError> =>
  Layer.effect(MarkdownNoteRepository, makeMarkdownNoteRepository(config))

// The renderer is shared with the parser test and repository; keeping this
// small wrapper here documents that writes use the canonical serializer.
const renderDocument = (note: ParsedMarkdownNote): string =>
  renderNoteDocument({
    metadata: note.metadata,
    body: note.body,
    unknown: note.unknown,
  })

export const lockPathFor = (root: string): string =>
  join(resolve(root), STATE_DIRECTORY, LOCK_FILENAME)
