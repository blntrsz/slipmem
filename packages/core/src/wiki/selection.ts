import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { basename } from "node:path"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import { wikiError, type WikiError } from "./errors.js"

export const DEFAULT_WIKI_LIMIT = Markdown.DEFAULT_WIKI_LIMIT
export const MAX_WIKI_LIMIT = Markdown.MAX_WIKI_LIMIT
export const MAX_TOPIC_SUGGESTIONS = 10

export interface WikiSelectionInput {
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  readonly topic: string
  readonly limit?: number
  readonly includeFleeting?: boolean
}

export interface WikiSelection {
  /** Normalized topic slug. */
  readonly topic: string
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  /** Bounded existing topics when a request returns no notes. */
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

const containsTopic = (text: string, topic: string): boolean => {
  const normalized = text.toLowerCase()
  return (
    normalized.includes(topic) ||
    normalized.includes(topic.replace(/-/g, " "))
  )
}

interface ScoredNote {
  readonly note: ParsedMarkdownNote
  readonly exactTopic: boolean
  readonly score: number
}

const scoreNote = (note: ParsedMarkdownNote, topic: string): ScoredNote => {
  const exactTopic = (note.metadata.topics ?? []).includes(topic)
  const title = containsTopic(note.metadata.title, topic)
  const reference =
    note.metadata.reference === undefined
      ? false
      : containsTopic(note.metadata.reference, topic)
  const body = containsTopic(note.body, topic)
  const score =
    (exactTopic ? 1000 : 0) +
    (title ? 300 : 0) +
    (reference ? 200 : 0) +
    (body ? 100 : 0)

  return { note, exactTopic, score }
}

const compareScored = (left: ScoredNote, right: ScoredNote): number => {
  if (left.exactTopic !== right.exactTopic) {
    return left.exactTopic ? -1 : 1
  }
  if (left.score !== right.score) {
    return right.score - left.score
  }
  if (left.note.info.updatedAt !== right.note.info.updatedAt) {
    return right.note.info.updatedAt - left.note.info.updatedAt
  }
  return left.note.id.localeCompare(right.note.id)
}

const topicSuggestions = (
  notes: ReadonlyArray<ParsedMarkdownNote>,
  requested: string,
): ReadonlyArray<string> => {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const topic of note.metadata.topics ?? []) {
      if (topic === requested) {
        continue
      }
      counts.set(topic, (counts.get(topic) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort(
      ([leftTopic, leftCount], [rightTopic, rightCount]) =>
        rightCount - leftCount || leftTopic.localeCompare(rightTopic),
    )
    .slice(0, MAX_TOPIC_SUGGESTIONS)
    .map(([topic]) => topic)
}

/**
 * Deterministic topic-first selection shared by CLI, MCP, HTTP, and web.
 *
 * 1. Normalize the display topic with the frozen pipeline; an empty slug is an
 *    error, not an empty page.
 * 2. Keep permanent and literature notes by default; fleeting notes require an
 *    explicit opt-in.
 * 3. Rank exact `topics` membership first, then title, reference, and body
 *    matches. Body fallback is bounded by the final note limit.
 * 4. Return suggestions from existing topics when nothing matches.
 */
export const selectWikiNotes = (
  input: WikiSelectionInput,
): Effect.Effect<WikiSelection, WikiError> => {
  const topic = Markdown.slugifyTopic(input.topic)
  if (topic === "") {
    return Effect.fail(
      wikiError({
        code: "invalid-topic",
        topic: input.topic,
        field: "topic",
        message: `Topic '${input.topic}' does not normalize to a usable slug. Use letters or digits.`,
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
        .map((note) => scoreNote(note, topic))
        .filter((scored) => scored.exactTopic || scored.score > 0)
        .sort(compareScored)
        .slice(0, limit)
        .map((scored) => scored.note)

      return {
        topic,
        notes: selected,
        suggestions:
          selected.length === 0 ? topicSuggestions(candidates, topic) : [],
      }
    }),
  )
}

/** Citation path form used by the wiki contract: `<root basename>/<filename>`. */
export const wikiCitationPath = (
  root: string,
  note: ParsedMarkdownNote,
): string => `${basename(root)}/${note.filename}`
