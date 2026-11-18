import { Markdown } from "@slipmem/schemas/markdown"
import type { ParsedMarkdownNote } from "@slipmem/core"
import { usageError } from "./errors.js"

export const parseNoteType = (
  value: string | undefined,
  command: string,
): Markdown.NoteType | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Markdown.NOTE_TYPES.includes(value as Markdown.NoteType)) {
    throw usageError(
      `--type must be one of ${Markdown.NOTE_TYPES.join(", ")}, not '${value}'.`,
      command,
    )
  }
  return value as Markdown.NoteType
}

export const requireNoteType = (
  value: string | undefined,
  command: string,
): Markdown.NoteType => {
  if (value === undefined) {
    throw usageError("--type is required.", command)
  }
  return parseNoteType(value, command)!
}

export const parseLimit = (
  value: number | undefined,
  options: {
    readonly command: string
    readonly fallback: number
    readonly maximum?: number
  },
): number => {
  if (value === undefined) {
    return options.fallback
  }
  const maximum = options.maximum ?? Markdown.MAX_SEARCH_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw usageError(
      `--limit must be an integer between 1 and ${maximum}.`,
      options.command,
    )
  }
  return value
}

/**
 * `--tag` is repeatable and each value may be a comma-separated list, so both
 * `--tag a --tag b` and `--tag a,b` work without a second option name.
 */
export const tagValues = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

export const citationPath = (root: string, filename: string): string => {
  const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root
  return `${name}/${filename}`
}

export const noteToJson = (
  root: string,
  note: ParsedMarkdownNote,
): Record<string, unknown> => ({
  id: note.id,
  path: note.path,
  citation: citationPath(root, note.filename),
  filename: note.filename,
  type: note.metadata.type,
  title: note.metadata.title,
  createdAt: note.metadata.createdAt,
  updatedAt: note.metadata.updatedAt,
  tags: note.metadata.tags ?? [],
  ...(note.metadata.reference === undefined
    ? {}
    : { reference: note.metadata.reference }),
  ...(note.metadata.provenance === undefined
    ? {}
    : { provenance: note.metadata.provenance }),
  ...(note.metadata.legacyId === undefined ? {} : { legacyId: note.metadata.legacyId }),
  ...(note.metadata.aliases === undefined ? {} : { aliases: note.metadata.aliases }),
  content: note.body,
  contentHash: note.contentHash,
  size: note.size,
})
