import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { resolve } from "node:path"
import { MarkdownError } from "./errors.js"
import { scanMarkdownRoot, type RepositoryScan } from "./repository.js"

export type CheckSeverity = "error" | "warning"

export interface NoteCheckIssue {
  readonly severity: CheckSeverity
  readonly area: MarkdownError["area"]
  readonly code: string
  readonly path: string
  readonly field?: string
  readonly message: string
}

export interface IndexFingerprint {
  readonly id: string
  readonly contentHash: string
}

export interface CheckNoteRootOptions {
  /**
   * Optional index snapshot. Supplying it enables drift checks without making
   * `check` depend on opening SQLite; a rebuild is always the recovery path.
   */
  readonly index?: ReadonlyArray<IndexFingerprint>
}

export interface NoteCheckReport {
  readonly root: string
  readonly ok: boolean
  readonly noteCount: number
  readonly scannedFiles: number
  readonly issues: ReadonlyArray<NoteCheckIssue>
  readonly warnings: ReadonlyArray<NoteCheckIssue>
  readonly notes: ReadonlyArray<{
    readonly id: string
    readonly path: string
    readonly type: Markdown.NoteType
    readonly title: string
  }>
  readonly index: {
    readonly checked: boolean
    readonly drift: number
  }
}

const fromError = (error: MarkdownError): NoteCheckIssue => ({
  severity: "error",
  area: error.area,
  code: error.code,
  path: error.path,
  ...(error.field === undefined ? {} : { field: error.field }),
  message: error.message,
})

const warning = (
  code: string,
  path: string,
  message: string,
  field?: string,
): NoteCheckIssue => ({
  severity: "warning",
  area: "repository",
  code,
  path,
  ...(field === undefined ? {} : { field }),
  message,
})

const collisionSuffix = /-\d+$/
const ID_PREFIX_LENGTH = 15

/**
 * The filename slug is the title slug at creation time, optionally followed by
 * a same-second collision suffix. Compare the exact slug first: stripping a
 * trailing number unconditionally would report false drift for a title such as
 * "Agent memory 2" whose own slug legitimately ends in `-2`.
 */
const slugMatchesTitle = (title: string, id: string): boolean => {
  const slug = id.slice(ID_PREFIX_LENGTH)
  const expected = Markdown.slugifyTitle(title)
  if (slug === expected) {
    return true
  }

  const collision = collisionSuffix.exec(slug)
  return (
    collision !== null && slug.slice(0, collision.index) === expected
  )
}

const buildReport = (
  root: string,
  scan: RepositoryScan,
  options: CheckNoteRootOptions,
): NoteCheckReport => {
  const issues: NoteCheckIssue[] = scan.invalid.map(fromError)
  const warnings: NoteCheckIssue[] = []

  for (const entry of scan.unexpected) {
    warnings.push(
      warning(
        entry.isNoteFilename ? "unexpected-entry" : "unexpected-file",
        entry.path,
        entry.isNoteFilename
          ? "A note filename must be a regular file, not a directory or special entry."
          : "This file is not a note and is ignored by the index.",
      ),
    )
  }

  const seen = new Map<string, string>()
  for (const note of scan.notes) {
    const previous = seen.get(note.id)
    if (previous !== undefined) {
      issues.push({
        severity: "error",
        area: "filename",
        code: "duplicate-id",
        path: note.path,
        message: `Duplicate note ID '${note.id}' also appears at ${previous}.`,
      })
    } else {
      seen.set(note.id, note.path)
    }

    if (!slugMatchesTitle(note.metadata.title, note.id)) {
      warnings.push(
        warning(
          "slug-drift",
          note.path,
          "The filename slug no longer matches the title. This is allowed; renaming is opt-in and not performed by check.",
          "title",
        ),
      )
    }
  }

  let drift = 0
  if (options.index !== undefined) {
    const indexed = new Map(options.index.map((entry) => [entry.id, entry.contentHash]))
    for (const note of scan.notes) {
      const hash = indexed.get(note.id)
      if (hash === undefined) {
        drift++
        warnings.push(
          warning(
            "index-missing",
            note.path,
            "The note is not in the derived index. Run 'slipmem check --rebuild-index'.",
          ),
        )
      } else if (hash !== note.contentHash) {
        drift++
        warnings.push(
          warning(
            "index-stale",
            note.path,
            "The derived index has an older content hash. Refresh or rebuild the index.",
          ),
        )
      }
      indexed.delete(note.id)
    }

    for (const [id] of indexed) {
      drift++
      warnings.push(
        warning(
          "index-extra",
          root,
          `The derived index contains stale note id '${id}' that no longer exists. Rebuild the index.`,
        ),
      )
    }
  }

  return {
    root,
    ok: issues.length === 0,
    noteCount: scan.notes.length,
    scannedFiles:
      scan.notes.length + scan.invalid.length + scan.unexpected.length,
    issues,
    warnings,
    notes: scan.notes.map((note) => ({
      id: note.id,
      path: note.path,
      type: note.metadata.type,
      title: note.metadata.title,
    })),
    index: { checked: options.index !== undefined, drift },
  }
}

/**
 * Read-only repository health check. It never repairs, renames, or writes.
 * Errors are contract violations; warnings include non-note files, slug drift,
 * and recoverable index drift.
 */
export const checkNoteRoot = (
  root: string,
  options: CheckNoteRootOptions = {},
): Effect.Effect<NoteCheckReport, never> =>
  Effect.gen(function* () {
    const absoluteRoot = resolve(root)
    const scan = yield* scanMarkdownRoot(absoluteRoot).pipe(
      Effect.match({
        onFailure: (error) => ({ error, scan: null }),
        onSuccess: (result) => ({ error: null, scan: result }),
      }),
    )

    if (scan.error !== null) {
      return {
        root: absoluteRoot,
        ok: false,
        noteCount: 0,
        scannedFiles: 0,
        issues: [fromError(scan.error)],
        warnings: [],
        notes: [],
        index: { checked: false, drift: 0 },
      }
    }

    return buildReport(absoluteRoot, scan.scan!, options)
  })

/** Builds the drift input from an index snapshot without importing SQLite. */
export const indexFingerprints = (
  snapshot: ReadonlyArray<{ readonly id: string; readonly contentHash: string }>,
): ReadonlyArray<IndexFingerprint> =>
  snapshot.map(({ id, contentHash }) => ({ id, contentHash }))
