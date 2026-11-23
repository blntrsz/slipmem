import { Markdown } from "@slipmem/schemas/markdown"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import type { WikiSelection } from "./selection.js"
import { wikiCitationPath } from "./selection.js"

export const MAX_WIKI_EXCERPT_CHARS = 600
export const MAX_WIKI_OUTPUT_CHARS = 20_000
/** Bound for the whole structured page, including every nested field. */
export const MAX_WIKI_STRUCTURED_CHARS = 2 * MAX_WIKI_OUTPUT_CHARS
export const MAX_WIKI_HEADING_CHARS = 120
export const MAX_WIKI_SOURCE_TITLE_CHARS = 200
export const MAX_WIKI_CITATION_PATH_CHARS = 300
export const MAX_WIKI_TAG_CHARS = 120
export const MAX_SYNTHESIS_SENTENCES = 60
export const MAX_SYNTHESIS_SENTENCE_CHARS = 500

const normalizeSpan = (value: string): string =>
  value.replace(/\s+/g, " ").trim()

/** Bounds an arbitrary metadata string at a word boundary when possible. */
export const boundWikiText = (value: string, maxChars: number): string => {
  const collapsed = normalizeSpan(value)
  if (collapsed.length <= maxChars) {
    return collapsed
  }
  const head = collapsed.slice(0, maxChars)
  const wordEnd = head.lastIndexOf(" ")
  return (wordEnd > Math.floor(maxChars * 0.6) ? head.slice(0, wordEnd) : head).trim()
}

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

    const citationPath = boundWikiText(
      wikiCitationPath(options.root, note),
      MAX_WIKI_CITATION_PATH_CHARS,
    )
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
  path: boundWikiText(
    wikiCitationPath(root, note),
    MAX_WIKI_CITATION_PATH_CHARS,
  ),
  type: note.metadata.type,
  title:
    boundWikiText(note.metadata.title, MAX_WIKI_SOURCE_TITLE_CHARS) ||
    "Untitled",
  updatedAt: Markdown.toUtcTimestamp(note.info.updatedAt).isoTimestamp,
})

const looksLikeIncompleteCitation = (line: string): boolean => {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return false
  }
  if (trimmed.includes("[[") && !trimmed.includes("]]")) {
    return true
  }
  return trimmed.includes("(`") && !trimmed.includes("`)")
}

/**
 * Last-resort bound for rendered Markdown. It cuts only at a line boundary and
 * drops a trailing partial citation line, so a standalone truncated page never
 * contains a citation that is cut off midway and no longer addressable.
 *
 * Do not use this on a page that also returns structured `sections`: the string
 * would no longer be a rendering of those sections. The wiki assembler instead
 * drops whole trailing sections so the Markdown and structured results always
 * agree.
 */
export const truncateWikiMarkdownSafely = (
  markdown: string,
  maxChars: number,
): string => {
  if (markdown.length <= maxChars) {
    return markdown
  }
  const suffix = "\n\n_Output truncated at the wiki bound._"
  const head = markdown.slice(0, Math.max(0, maxChars - suffix.length))
  const lines = head.slice(0, head.lastIndexOf("\n") + 1).split("\n")
  while (lines.length > 0 && looksLikeIncompleteCitation(lines[lines.length - 1]!)) {
    lines.pop()
  }
  return `${lines.join("\n").trimEnd()}${suffix}`
}

export type WikiEmptyReason =
  | "no-matches"
  | "no-supported-sentences"
  | "output-truncated"

export interface RenderPageInput {
  readonly tag: string
  readonly generatedAt: string
  readonly mode: Markdown.WikiMode
  readonly sources: ReadonlyArray<Markdown.WikiSource>
  readonly sections: ReadonlyArray<WikiSectionDraft>
  readonly suggestions?: ReadonlyArray<string>
  readonly omittedSentences?: number
  readonly emptyReason?: WikiEmptyReason
  readonly truncated?: boolean
}

/**
 * Renders the canonical page Markdown from the same sections returned in the
 * structured result. The string is bounded by construction; the caller still
 * applies the final hard cap.
 */
export const renderWikiMarkdown = ({
  tag,
  generatedAt,
  mode,
  sources,
  sections,
  suggestions,
  omittedSentences,
  emptyReason,
  truncated,
}: RenderPageInput): string => {
  const noteWord = sources.length === 1 ? "note" : "notes"
  const modeLine =
    mode === "extractive"
      ? "Extractive; verify sources."
      : "Synthesized from a locally configured source; verify citations."
  const lines: string[] = [
    `# Tag: ${tag}`,
    "",
    `_Generated on ${generatedAt} from ${sources.length} ${noteWord}. ${modeLine}_`,
  ]

  if (sections.length === 0) {
    lines.push("")
    if (
      emptyReason === "no-supported-sentences" ||
      (emptyReason === undefined && omittedSentences !== undefined && omittedSentences > 0)
    ) {
      lines.push(
        omittedSentences === undefined || omittedSentences === 0
          ? "The synthesizer returned no sentences supported by the selected notes. No synthesized prose was generated; use extractive mode for a fully quoted fallback."
          : `No synthesized sentences passed citation validation (${omittedSentences} omitted). Use extractive mode for a fully quoted fallback.`,
      )
    } else if (emptyReason === "output-truncated") {
      lines.push(
        "The selected notes could not fit within the wiki output bound, so no sections were rendered. Raise the limit only if the output bound allows it, or read the notes directly.",
      )
    } else if (suggestions !== undefined && suggestions.length > 0) {
      lines.push(
        `No notes matched this tag. Try one of: ${suggestions.join(", ")}.`,
      )
    } else {
      lines.push(
        "No notes matched this tag. Nothing was generated; add a note with this tag or title.",
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
