import { Effect } from "effect"
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { Markdown } from "@slipmem/schemas/markdown"
import { MarkdownError, markdownError } from "./errors.js"
import { parseMarkdownNote, type ParsedMarkdownNote } from "./note-document.js"
import { isPathInside } from "./root.js"

export const NOTE_SUFFIX = ".md"

const pathError = (
  root: string,
  code: "path-outside-root" | "symlink" | "not-found" | "file-too-large",
  path: string,
  message: string,
): MarkdownError =>
  markdownError({ area: "path", code, path, message })

/**
 * Turns an ID into the only legal note path for this root.
 *
 * IDs are validated as filename stems before any path operation, then the
 * resolved path is checked to be a direct child of the root. This rejects
 * traversal, separators, absolute paths, and sibling roots even on platforms
 * where path normalization is surprising.
 */
export const notePath = (
  root: string,
  id: string,
): Effect.Effect<string, MarkdownError> =>
  Effect.gen(function* () {
    if (!Markdown.isNoteId(id)) {
      return yield* Effect.fail(
        pathError(
          root,
          "path-outside-root",
          join(root, id),
          `Note ID '${id}' is not a direct kebab-case note filename stem.`,
        ),
      )
    }

    const absoluteRoot = resolve(root)
    const path = resolve(absoluteRoot, `${id}${NOTE_SUFFIX}`)
    if (dirname(path) !== absoluteRoot || !isPathInside(path, absoluteRoot)) {
      return yield* Effect.fail(
        pathError(
          absoluteRoot,
          "path-outside-root",
          path,
          "Note paths must be direct children of the note root.",
        ),
      )
    }

    return path
  })

export interface NoteFileStat {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/** Stats a note path without following a symlink. Missing files are ignored. */
export const statNoteFile = (
  root: string,
  id: string,
): Effect.Effect<NoteFileStat | null, MarkdownError> =>
  Effect.gen(function* () {
    const path = yield* notePath(root, id)
    if (!existsSync(path)) {
      return null
    }

    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(path)
    } catch (cause) {
      return yield* Effect.fail(
        pathError(
          root,
          "not-found",
          path,
          `Could not inspect the note path: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        pathError(root, "symlink", path, "Symlinked note files are not allowed."),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        pathError(root, "not-found", path, "The note path is not a regular file."),
      )
    }

    // A realpath check catches a symlinked intermediate directory even though
    // the note filename itself passed the direct-child check.
    try {
      const realRoot = realpathSync(root)
      const realFile = realpathSync(path)
      if (!isPathInside(realFile, realRoot)) {
        return yield* Effect.fail(
          pathError(
            root,
            "symlink",
            path,
            "The note path resolves outside the note root.",
          ),
        )
      }
    } catch (cause) {
      return yield* Effect.fail(
        pathError(
          root,
          "not-found",
          path,
          `Could not resolve the note path: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    return { path, size: stats.size, mtimeMs: stats.mtimeMs }
  })

export interface ReadNoteFileResult {
  readonly path: string
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
}

/** Reads and parses one note by ID with all path and size guards applied. */
export const readNoteFile = (
  root: string,
  id: string,
): Effect.Effect<ParsedMarkdownNote | null, MarkdownError> =>
  Effect.gen(function* () {
    const stats = yield* statNoteFile(root, id)
    if (stats === null) {
      return null
    }

    if (stats.size > Markdown.MAX_NOTE_FILE_BYTES) {
      return yield* Effect.fail(
        pathError(
          root,
          "file-too-large",
          stats.path,
          `Note files must be ${Markdown.MAX_NOTE_FILE_BYTES} bytes or fewer.`,
        ),
      )
    }

    let content: string
    try {
      content = readFileSync(stats.path, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        markdownError({
          area: "repository",
          code: "not-found",
          path: stats.path,
          message: `Could not read note: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      )
    }

    return yield* parseMarkdownNote({
      path: stats.path,
      content,
      mtimeMs: stats.mtimeMs,
    })
  })

/** Reads a note by its already-validated direct-child filename. */
export const readNoteFilename = (
  root: string,
  filename: string,
): Effect.Effect<ParsedMarkdownNote, MarkdownError> => {
  const id = Markdown.noteIdFromFilename(filename)
  if (id === null) {
    return Effect.fail(
      pathError(
        root,
        "path-outside-root",
        join(root, filename),
        `'${filename}' is not a note filename.`,
      ),
    )
  }
  return readNoteFile(root, id).pipe(
    Effect.flatMap((note) =>
      note === null
        ? Effect.fail(
            pathError(
              root,
              "not-found",
              join(root, filename),
              "The note file disappeared while it was being read.",
            ),
          )
        : Effect.succeed(note),
    ),
  )
}

export type RepositoryEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "other"

export interface RepositoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: RepositoryEntryKind
  readonly isNoteFilename: boolean
}

/**
 * Lists direct children without following symlinks. Check and scan use this
 * view; note listing filters to `isNoteFilename && kind === "file"`.
 */
export const listRootEntries = (
  root: string,
): Effect.Effect<ReadonlyArray<RepositoryEntry>, MarkdownError> =>
  Effect.gen(function* () {
    const absoluteRoot = resolve(root)
    let names: ReadonlyArray<string>
    try {
      names = readdirSync(absoluteRoot)
    } catch (cause) {
      return yield* Effect.fail(
        markdownError({
          area: "repository",
          code: "repository-root-missing",
          path: absoluteRoot,
          message: `Could not read the note root: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      )
    }

    return yield* Effect.try({
      try: () =>
        [...names].sort().map((name) => {
          const path = join(absoluteRoot, name)
          const stats = lstatSync(path)
          const kind: RepositoryEntryKind = stats.isSymbolicLink()
            ? "symlink"
            : stats.isFile()
              ? "file"
              : stats.isDirectory()
                ? "directory"
                : "other"
          return {
            name,
            path,
            kind,
            isNoteFilename: Markdown.isNoteFilename(name),
          }
        }),
      catch: (cause) =>
        markdownError({
          area: "repository",
          code: "not-found",
          path: absoluteRoot,
          message: `A note root entry changed while it was being inspected: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
  })

export const listNoteFilenames = (
  root: string,
): Effect.Effect<ReadonlyArray<string>, MarkdownError> =>
  listRootEntries(root).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.kind === "file" && entry.isNoteFilename)
        .map((entry) => entry.name),
    ),
  )

export const relativeNotePath = (root: string, filename: string): string =>
  `${basename(root)}${sep}${filename}`
