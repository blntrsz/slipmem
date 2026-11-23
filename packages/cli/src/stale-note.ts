import {
  markdownError,
  type MarkdownError,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Effect } from "effect"
import { stringOption, type ParsedArguments } from "./args.js"
import { usageError } from "./errors.js"

/**
 * Reads the optional explicit base revision for an edit or delete. The same
 * value is available as `--expect` (the primary spelling) and `--revision`
 * (the HTTP field name). Supplying both with different values fails closed.
 */
export const expectedRevisionOption = (
  parsed: ParsedArguments,
  command: string,
): string | undefined => {
  const expect = stringOption(parsed, "expect")
  const revision = stringOption(parsed, "revision")

  if (expect !== undefined && revision !== undefined && expect !== revision) {
    throw usageError("--expect and --revision must name the same revision.", command)
  }

  const value = expect ?? revision
  if (value === undefined) {
    return undefined
  }
  let normalized = value.trim()
  if (normalized.startsWith("W/")) {
    normalized = normalized.slice(2).trim()
  }
  if (
    normalized.length >= 2 &&
    normalized.startsWith('"') &&
    normalized.endsWith('"')
  ) {
    normalized = normalized.slice(1, -1)
  }
  if (normalized === "") {
    throw usageError("--expect must name a non-empty content hash.", command)
  }
  return normalized
}

const shortHash = (hash: string): string =>
  hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`

/**
 * A caller-supplied revision that no longer matches is a stale-base conflict,
 * not a usage error. Nothing has been written when this fails.
 */
export const assertExpectedRevision = (
  note: ParsedMarkdownNote,
  expected: string | undefined,
  command: "edit" | "delete",
): Effect.Effect<void, MarkdownError> =>
  expected === undefined || note.contentHash === expected
    ? Effect.void
    : Effect.fail(
        markdownError({
          area: "repository",
          code: "stale-base",
          path: note.path,
          message:
            command === "edit"
              ? `Note '${note.id}' changed after it was read (expected ${shortHash(expected)}, found ${shortHash(note.contentHash)}). Nothing was written; re-read the note and retry.`
              : `Note '${note.id}' changed after it was read (expected ${shortHash(expected)}, found ${shortHash(note.contentHash)}). Nothing was deleted; re-read the note and retry.`,
        }),
      )
