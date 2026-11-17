import { Markdown } from "@slipmem/schemas/markdown"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import type { WikiSelection } from "./selection.js"
import { wikiCitationPath } from "./selection.js"

export const MAX_WIKI_EXCERPT_CHARS = 600
export const MAX_WIKI_OUTPUT_CHARS = 20_000
export const MAX_WIKI_HEADING_CHARS = 120
export const MAX_SYNTHESIS_SENTENCES = 60
export const MAX_SYNTHESIS_SENTENCE_CHARS = 500

const normalizeSpan = (value: string): string =>
  value.replace(/\s+/g, " ").trim()

/** Whitespace-insensitive comparison used by the exact-span validator. */
export const normalizeSupportSpan = normalizeSpan

/**
 * Cuts a verbatim excerpt at a sentence or word boundary. The returned value is
 * always a substring of the original body, so an extractive excerpt can never
 * be a paraphrase.
 */
export const boundExcerpt = (body: string, maxChars: number): string => {
  const trimmed = body.trim()
  if (maxChars <= 0) {
    return ""
  }
  if (trimmed.length <= maxChars) {
    return trimmed
  }

  const head = trimmed.slice(0, maxChars)
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  )
  if (sentenceEnd >= Math.floor(maxChars * 0.6)) {
    return head.slice(0, sentenceEnd + 1).trim()
  }

  const wordEnd = head.lastIndexOf(" ")
  return (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim()
}

export const sanitizeHeading = (title: string): string => {
  const collapsed = title.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim()
  const bounded =
    collapsed.length <= MAX_WIKI_HEADING_CHARS
      ? collapsed
      : collapsed.slice(0, MAX_WIKI_HEADING_CHARS).trimEnd()
  return bounded.length === 0 ? "Untitled" : bounded
}

export const blockquote = (excerpt: string): string =>
  excerpt
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n")

export interface WikiSectionDraft {
  readonly heading: string
  readonly markdown: string
  readonly citations: ReadonlyArray<{
    readonly noteId: string
    readonly path: string
    readonly excerpt: string
  }>
}

export interface ExtractiveSections {
  readonly sections: ReadonlyArray<WikiSectionDraft>
  readonly used: ReadonlyArray<ParsedMarkdownNote>
  readonly truncated: boolean
}

/**
 * Builds one verbatim, cited section per selected note within a total character
 * budget. Conflicting notes naturally stay in separate sections with separate
 * citations; nothing is merged into one unattributed claim.
 */
export const extractiveSections = (
  selection: WikiSelection,
  options: {
    readonly root: string
    readonly excerptChars?: number
    readonly maxOutputChars?: number
  },
): ExtractiveSections => {
  const excerptChars = Math.min(
    options.excerptChars ?? MAX_WIKI_EXCERPT_CHARS,
    MAX_WIKI_EXCERPT_CHARS,
  )
  const maxOutputChars = options.maxOutputChars ?? MAX_WIKI_OUTPUT_CHARS
  // Reserve room for the title, metadata line, source list, and separators.
  let budget = Math.max(0, maxOutputChars - 1200)
  const sections: WikiSectionDraft[] = []
  const used: ParsedMarkdownNote[] = []
  let truncated = false

  for (const note of selection.notes) {
    const available = Math.min(excerptChars, budget)
    if (available < 20) {
      truncated = true
      break
    }
    const excerpt = boundExcerpt(note.body, available)
    if (excerpt.length === 0) {
      truncated = true
      continue
    }

    const citationPath = wikiCitationPath(options.root, note)
    const heading = sanitizeHeading(note.metadata.title)
    const markdown = blockquote(excerpt)
    sections.push({
      heading,
      markdown,
      citations: [{ noteId: note.id, path: citationPath, excerpt }],
    })
    used.push(note)
    budget -= excerpt.length + heading.length + citationPath.length + 80
  }

  return { sections, used, truncated }
}

export const wikiSourceFromNote = (
  root: string,
  note: ParsedMarkdownNote,
): Markdown.WikiSource => ({
  id: note.id,
  path: wikiCitationPath(root, note),
  type: note.metadata.type,
  title: note.metadata.title,
  updatedAt: Markdown.toUtcTimestamp(note.info.updatedAt).isoTimestamp,
})

export interface RenderPageInput {
  readonly topic: string
  readonly generatedAt: string
  readonly mode: Markdown.WikiMode
  readonly sources: ReadonlyArray<Markdown.WikiSource>
  readonly sections: ReadonlyArray<WikiSectionDraft>
  readonly suggestions?: ReadonlyArray<string>
  readonly omittedSentences?: number
  readonly truncated?: boolean
}

/**
 * Renders the canonical page Markdown from the same sections returned in the
 * structured result. The string is bounded by construction; the caller still
 * applies the final hard cap.
 */
export const renderWikiMarkdown = ({
  topic,
  generatedAt,
  mode,
  sources,
  sections,
  suggestions,
  omittedSentences,
  truncated,
}: RenderPageInput): string => {
  const noteWord = sources.length === 1 ? "note" : "notes"
  const modeLine =
    mode === "extractive"
      ? "Extractive; verify sources."
      : "Synthesized from a locally configured source; verify citations."
  const lines: string[] = [
    `# Topic: ${topic}`,
    "",
    `_Generated on ${generatedAt} from ${sources.length} ${noteWord}. ${modeLine}_`,
  ]

  if (sections.length === 0) {
    lines.push("")
    if (omittedSentences !== undefined && omittedSentences > 0) {
      lines.push(
        `No synthesized sentences passed citation validation (${omittedSentences} omitted). Use extractive mode for a fully quoted fallback.`,
      )
    } else if (suggestions !== undefined && suggestions.length > 0) {
      lines.push(
        `No notes matched this topic. Try one of: ${suggestions.join(", ")}.`,
      )
    } else {
      lines.push(
        "No notes matched this topic. Nothing was generated; add a note with this topic or title.",
      )
    }
  }

  for (const section of sections) {
    lines.push("", `## ${section.heading}`, "", section.markdown)
    // Extractive section Markdown is only the quoted excerpt, so the renderer
    // adds its adjacent citation. Synthesized section Markdown already carries
    // one citation after every sentence; adding a second block would duplicate.
    if (mode === "extractive") {
      const citations = section.citations
        .map((citation) => `Source: [[${citation.noteId}]] (\`${citation.path}\`)`)
        .join("\n")
      if (citations.length > 0) {
        lines.push("", citations)
      }
    }
  }

  if (sections.length > 0) {
    lines.push("", "## Sources", "")
    for (const source of sources) {
      lines.push(`- [[${source.id}]] - ${source.title}`)
    }
  }

  if (sections.length > 0 && omittedSentences !== undefined && omittedSentences > 0) {
    lines.push(
      "",
      `${omittedSentences} synthesized sentence${omittedSentences === 1 ? "" : "s"} did not pass citation validation and were omitted.`,
    )
  }
  if (truncated === true) {
    lines.push("", "_Output was truncated at the wiki bound._")
  }

  return lines.join("\n")
}
