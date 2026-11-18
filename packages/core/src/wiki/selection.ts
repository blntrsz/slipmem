import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { basename } from "node:path"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import { wikiError, type WikiError } from "./errors.js"

export const DEFAULT_WIKI_LIMIT = Markdown.DEFAULT_WIKI_LIMIT
export const MAX_WIKI_LIMIT = Markdown.MAX_WIKI_LIMIT
export const MAX_TAG_SUGGESTIONS = 10

export interface WikiSelectionInput {
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  readonly tag: string
  readonly limit?: number
  readonly includeFleeting?: boolean
}

export interface WikiSelection {
  /** Normalized tag slug. */
  readonly tag: string
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  /** Bounded existing tags when a request returns no notes. */
  readonly suggestions: ReadonlyArray<string>
}

const validateLimit = (limit: number | undefined): Effect.Effect<number, WikiError> => {
  if (limit === undefined) {
    return Effect.succeed(DEFAULT_WIKI_LIMIT)
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WIKI_LIMIT) {
    return Effect.fail(
      wikiError({
        code: "invalid-limit",
        field: "limit",
        message: `Wiki limit must be an integer between 1 and ${MAX_WIKI_LIMIT}. Received ${String(limit)}.`,
      }),
    )
  }
  return Effect.succeed(limit)
}

const defaultTypes: ReadonlyArray<Markdown.NoteType> = ["permanent", "literature"]

const containsTag = (text: string, tag: string): boolean => {
  const normalized = text.toLowerCase()
  return (
    normalized.includes(tag) ||
    normalized.includes(tag.replace(/-/g, " "))
  )
}

interface ScoredNote {
  readonly note: ParsedMarkdownNote
  readonly exactTag: boolean
  readonly score: number
}

const scoreNote = (note: ParsedMarkdownNote, tag: string): ScoredNote => {
  const exactTag = (note.metadata.tags ?? []).includes(tag)
  const title = containsTag(note.metadata.title, tag)
  const reference =
    note.metadata.reference === undefined
      ? false
      : containsTag(note.metadata.reference, tag)
  const body = containsTag(note.body, tag)
  const score =
    (exactTag ? 1000 : 0) +
    (title ? 300 : 0) +
    (reference ? 200 : 0) +
    (body ? 100 : 0)

  return { note, exactTag, score }
}

const compareScored = (left: ScoredNote, right: ScoredNote): number => {
  if (left.exactTag !== right.exactTag) {
    return left.exactTag ? -1 : 1
  }
  if (left.score !== right.score) {
    return right.score - left.score
  }
  if (left.note.info.updatedAt !== right.note.info.updatedAt) {
    return right.note.info.updatedAt - left.note.info.updatedAt
  }
  return left.note.id.localeCompare(right.note.id)
}

const tagSuggestions = (
  notes: ReadonlyArray<ParsedMarkdownNote>,
  requested: string,
): ReadonlyArray<string> => {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const tag of note.metadata.tags ?? []) {
      if (tag === requested) {
        continue
      }
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort(
      ([leftTag, leftCount], [rightTag, rightCount]) =>
        rightCount - leftCount || leftTag.localeCompare(rightTag),
    )
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map(([tag]) => tag)
}

/**
 * Deterministic tag-first selection shared by CLI, MCP, HTTP, and web.
 *
 * 1. Normalize the display tag with the frozen pipeline; an empty slug is an
 *    error, not an empty page.
 * 2. Keep permanent and literature notes by default; fleeting notes require an
 *    explicit opt-in.
 * 3. Rank exact `tags` membership first, then title, reference, and body
 *    matches. Body fallback is bounded by the final note limit.
 * 4. Return suggestions from existing tags when nothing matches.
 */
export const selectWikiNotes = (
  input: WikiSelectionInput,
): Effect.Effect<WikiSelection, WikiError> => {
  const tag = Markdown.slugifyTag(input.tag)
  if (tag === "") {
    return Effect.fail(
      wikiError({
        code: "invalid-tag",
        tag: input.tag,
        field: "tag",
        message: `Tag '${input.tag}' does not normalize to a usable slug. Use letters or digits.`,
      }),
    )
  }

  return validateLimit(input.limit).pipe(
    Effect.map((limit) => {
      const allowed = input.includeFleeting === true
        ? new Set<Markdown.NoteType>(["fleeting", "permanent", "literature"])
        : new Set<Markdown.NoteType>(defaultTypes)
      const candidates = input.notes.filter((note) =>
        allowed.has(note.metadata.type),
      )

      const selected = candidates
        .map((note) => scoreNote(note, tag))
        .filter((scored) => scored.exactTag || scored.score > 0)
        .sort(compareScored)
        .slice(0, limit)
        .map((scored) => scored.note)

      return {
        tag,
        notes: selected,
        suggestions:
          selected.length === 0 ? tagSuggestions(candidates, tag) : [],
      }
    }),
  )
}

/** Citation path form used by the wiki contract: `<root basename>/<filename>`. */
export const wikiCitationPath = (
  root: string,
  note: ParsedMarkdownNote,
): string => `${basename(root)}/${note.filename}`
