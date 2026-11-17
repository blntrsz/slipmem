import { Markdown } from "@slipmem/schemas/markdown"
import type { ParsedMarkdownNote } from "@slipmem/core"
import { usageError } from "./errors.js"
import { citationPath } from "./note-values.js"

const MAX_EXCERPT_CHARS = 1200

const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim()

const truncate = (text: string, maximum: number): string => {
  if (text.length <= maximum) {
    return text
  }
  const head = text.slice(0, maximum)
  const boundary = head.search(/\s+\S*$/)
  return `${(boundary > 0 ? head.slice(0, boundary) : head).trimEnd()}…`
}

const quote = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")

const matchesTopic = (
  note: ParsedMarkdownNote,
  slug: string,
  display: string,
  terms: ReadonlyArray<string>,
): { readonly matched: boolean; readonly score: number } => {
  if ((note.metadata.topics ?? []).includes(slug)) {
    return { matched: true, score: 1000 }
  }

  const text = [
    note.metadata.title,
    note.body,
    note.metadata.reference ?? "",
  ]
    .join("\n")
    .toLowerCase()

  if (text.includes(slug) || text.includes(display)) {
    return { matched: true, score: 100 }
  }

  if (terms.length > 1 && terms.every((term) => text.includes(term))) {
    return { matched: true, score: 50 }
  }

  return { matched: false, score: 0 }
}

export interface ExtractiveWikiInput {
  readonly root: string
  readonly topic: string
  readonly notes: ReadonlyArray<ParsedMarkdownNote>
  readonly limit: number
  readonly includeFleeting: boolean
  readonly nowMs: number
}

export interface ExtractiveWiki {
  readonly page: Markdown.WikiPage
  readonly markdown: string
  /** IDs after selection, in output order. Used only for CLI summaries. */
  readonly selected: ReadonlyArray<string>
}

const renderMarkdown = (
  topic: string,
  page: Markdown.WikiPage,
  root: string,
  notes: ReadonlyArray<ParsedMarkdownNote>,
): string => {
  const lines = [
    `# Topic: ${oneLine(topic)}`,
    "",
    `_Generated on ${page.generatedAt} from ${page.noteCount} note${page.noteCount === 1 ? "" : "s"}. Extractive; verify sources._`,
    "",
  ]

  if (page.noteCount === 0) {
    lines.push(
      "No notes matched this topic. Add a note with a matching `topics` entry",
      "or title/body term; slipmem does not invent topic content.",
      "",
    )
  }

  for (const [index, note] of notes.entries()) {
    const section = page.sections[index]!
    lines.push(`## ${oneLine(section.heading)}`, "")
    lines.push(quote(section.markdown), "")
    lines.push(`Source: [[${note.id}]]`)
    lines.push(
      `(\`${citationPath(root, note.filename)}\`, ${note.metadata.type}, updated ${note.metadata.updatedAt})`,
      "",
    )
  }

  lines.push("## Sources", "")
  if (page.sources.length === 0) {
    lines.push("- None.")
  } else {
    for (const source of page.sources) {
      lines.push(`- [[${source.id}]] - ${oneLine(source.title)}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/**
 * Builds the basic extractive wiki from a bounded note selection. Every excerpt
 * is quoted from exactly one note and carries that note's ID and file path; no
 * prose is invented and no note is persisted.
 */
export const buildExtractiveWiki = (
  input: ExtractiveWikiInput,
): ExtractiveWiki => {
  const slug = Markdown.slugifyTopic(input.topic)
  if (slug === "") {
    throw usageError(
      `Topic '${input.topic}' does not normalize to a usable slug.`,
      "wiki",
    )
  }
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw usageError("--limit must be a positive integer.", "wiki")
  }

  const display = slug.replace(/-/g, " ")
  const terms = display.split(/\s+/).filter((term) => term.length > 0)
  const selected = input.notes
    .filter(
      (note) => input.includeFleeting || note.metadata.type !== "fleeting",
    )
    .map((note) => ({ note, ...matchesTopic(note, slug, display, terms) }))
    .filter((entry) => entry.matched)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.note.info.updatedAt - left.note.info.updatedAt ||
        (left.note.id < right.note.id ? -1 : left.note.id > right.note.id ? 1 : 0),
    )
    .slice(0, input.limit)
    .map((entry) => entry.note)

  const generatedAt = Markdown.toUtcTimestamp(input.nowMs).isoTimestamp
  const sources: Markdown.WikiSource[] = selected.map((note) => ({
    id: note.id,
    path: note.path,
    type: note.metadata.type,
    title: note.metadata.title,
    updatedAt: note.metadata.updatedAt,
  }))

  const sections: Markdown.WikiSection[] = selected.map((note) => {
    const excerpt = truncate(note.body, MAX_EXCERPT_CHARS)
    return {
      heading: oneLine(note.metadata.title),
      markdown: excerpt,
      citations: [
        {
          noteId: note.id,
          path: note.path,
          excerpt,
        },
      ],
    }
  })

  const page: Markdown.WikiPage = {
    topic: slug,
    generatedAt,
    mode: "extractive",
    noteCount: selected.length,
    sources,
    sections,
    markdown: "",
  }

  const markdown = renderMarkdown(input.topic.trim(), page, input.root, selected)
  return {
    page: { ...page, markdown },
    markdown,
    selected: selected.map((note) => note.id),
  }
}
