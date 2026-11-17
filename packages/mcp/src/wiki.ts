import type { ParsedMarkdownNote } from "@slipmem/core"
import { Markdown } from "@slipmem/schemas/markdown"
import {
  boundedExcerpt,
  MAX_WIKI_EXCERPT_LENGTH,
} from "./schemas"

export interface BuildExtractiveWikiInput {
  readonly topic: string
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  readonly limit: number
  readonly includeFleeting: boolean
  readonly generatedAt: number
}

const words = (slug: string): ReadonlyArray<string> =>
  slug.split("-").filter((word) => word.length > 0)

const includesAll = (haystack: string, tokens: ReadonlyArray<string>): boolean => {
  const normalized = haystack.toLowerCase()
  return tokens.length > 0 && tokens.every((token) => normalized.includes(token))
}

/**
 * Ranks one note against a topic. Exact frontmatter topics win, then title,
 * body, and literature reference matches. The rank is only an ordering hint;
 * no note text becomes a query or instruction.
 */
const topicRank = (
  note: ParsedMarkdownNote,
  topic: string,
  tokens: ReadonlyArray<string>,
): number | null => {
  if ((note.metadata.topics ?? []).includes(topic)) {
    return 0
  }
  if (includesAll(note.metadata.title, tokens)) {
    return 1
  }
  if (includesAll(note.body, tokens)) {
    return 2
  }
  if (
    note.metadata.reference !== undefined &&
    includesAll(note.metadata.reference, tokens)
  ) {
    return 3
  }
  return null
}

const isEligible = (
  note: ParsedMarkdownNote,
  includeFleeting: boolean,
): boolean => includeFleeting || note.metadata.type !== "fleeting"

const sources = (
  notes: ReadonlyArray<ParsedMarkdownNote>,
): ReadonlyArray<Markdown.WikiSource> =>
  notes.map((note) => ({
    id: note.id as Markdown.WikiSource["id"],
    path: note.path,
    type: note.metadata.type,
    title: note.metadata.title,
    updatedAt: Markdown.toUtcTimestamp(note.info.updatedAt).isoTimestamp,
  }))

const sectionFor = (note: ParsedMarkdownNote): Markdown.WikiSection => {
  const excerpt = boundedExcerpt(note.body, MAX_WIKI_EXCERPT_LENGTH)
  const quote = excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

  return {
    heading: note.metadata.title,
    markdown: `${quote}\n\nSource: [[${note.id}]] (\`${note.path}\`)`,
    citations: [
      {
        noteId: note.id as Markdown.WikiCitation["noteId"],
        path: note.path,
        excerpt,
      },
    ],
  }
}

const renderMarkdown = (
  topic: string,
  generatedAt: string,
  notes: ReadonlyArray<ParsedMarkdownNote>,
  sections: ReadonlyArray<Markdown.WikiSection>,
): string => {
  const header = [
    `# Topic: ${topic}`,
    "",
    `_Generated on ${generatedAt} from ${notes.length} ${
      notes.length === 1 ? "note" : "notes"
    }. Extractive; verify sources._`,
  ].join("\n")

  if (notes.length === 0) {
    return `${header}\n\nNo notes matched this topic. No content was invented.\n`
  }

  const body = sections
    .map((section) =>
      [
        `## ${section.heading}`,
        "",
        section.markdown,
      ].join("\n"),
    )
    .join("\n\n")

  const sourceList = [
    "## Sources",
    "",
    ...notes.map((note) => `- [[${note.id}]] - ${note.metadata.title}`),
  ].join("\n")

  return `${header}\n\n${body}\n\n${sourceList}\n`
}

/**
 * Builds a bounded, extractive topic page from a selected note set.
 *
 * Every section quotes one note and cites its ID and file. A topic with no
 * matches returns an empty page instead of inventing content. The note text is
 * only ever quoted as data; it is never interpreted as instructions.
 */
export const buildExtractiveWiki = (
  input: BuildExtractiveWikiInput,
): Markdown.WikiPage => {
  const topic = Markdown.slugifyTopic(input.topic)
  const tokens = words(topic)
  const ranked = input.notes
    .filter((note) => isEligible(note, input.includeFleeting))
    .map((note) => ({ note, rank: topicRank(note, topic, tokens) }))
    .filter(
      (entry): entry is { readonly note: ParsedMarkdownNote; readonly rank: number } =>
        entry.rank !== null,
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.note.info.updatedAt - left.note.info.updatedAt ||
        (left.note.id < right.note.id ? -1 : left.note.id > right.note.id ? 1 : 0),
    )
    .slice(0, input.limit)
    .map((entry) => entry.note)

  const generatedAt = Markdown.toUtcTimestamp(input.generatedAt).isoTimestamp
  const sections = ranked.map(sectionFor)

  return {
    topic,
    generatedAt,
    mode: "extractive",
    noteCount: ranked.length,
    sources: sources(ranked),
    sections,
    markdown: renderMarkdown(topic, generatedAt, ranked, sections),
  }
}
