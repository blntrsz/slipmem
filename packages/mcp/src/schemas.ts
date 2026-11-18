import { Markdown } from "@slipmem/schemas/markdown"
import { Note } from "@slipmem/schemas/note"
import { Schema } from "effect"

/**
 * MCP input schemas are the public tool contract. They intentionally accept
 * only user-authored fields; IDs, timestamps, provenance, and approval state
 * are server-owned.
 */
export const ListNotesInput = Schema.Struct({
  /** Server clamps to the 1..50 hard maximum; omitted means 10. */
  limit: Schema.optional(Schema.Int),
  tag: Schema.optional(Schema.String),
}).annotate({ identifier: "Mcp.ListNotesInput" })

export const GetNoteInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Mcp.GetNoteInput" })

const Tags = Schema.optional(Schema.Array(Schema.String))

export const CreateFleetingInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  tags: Tags,
}).annotate({ identifier: "Mcp.CreateFleetingInput" })

export const UpdateFleetingInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  tags: Tags,
}).annotate({ identifier: "Mcp.UpdateFleetingInput" })

export const CreatePermanentInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  tags: Tags,
}).annotate({ identifier: "Mcp.CreatePermanentInput" })

export const UpdatePermanentInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  tags: Tags,
}).annotate({ identifier: "Mcp.UpdatePermanentInput" })

export const CreateLiteratureInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.String,
  tags: Tags,
}).annotate({ identifier: "Mcp.CreateLiteratureInput" })

export const UpdateLiteratureInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  reference: Schema.optional(Schema.String),
  tags: Tags,
}).annotate({ identifier: "Mcp.UpdateLiteratureInput" })

export const DeleteNoteInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Mcp.DeleteNoteInput" })

export const SearchNotesInput = Schema.Struct({
  query: Schema.String,
  type: Schema.optional(Markdown.NoteType),
  tag: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Mcp.SearchNotesInput" })

export const ListTagsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Mcp.ListTagsInput" })

/**
 * The tag is accepted as display text and normalized by the shared slug
 * pipeline. An input that normalizes to nothing is rejected by the handler.
 */
export const BuildTagWikiInput = Schema.Struct({
  tag: Schema.String,
  limit: Schema.optional(Schema.Int),
  mode: Schema.optional(Markdown.WikiMode),
  includeFleeting: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Mcp.BuildTagWikiInput" })

/**
 * Recall responses use a summary instead of `Note.Info`. A full note can carry
 * up to 5000 body characters and its metadata is not length-bounded by the
 * storage contract, so echoing `Note.Info` multiplied both by a 50-result list.
 * Summaries keep enough to identify and cite a note while every field is
 * bounded.
 */
export interface NoteSummary extends Schema.Schema.Type<typeof NoteSummary> {}
export const NoteSummary = Schema.Struct({
  id: Schema.String,
  type: Markdown.NoteType,
  title: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  path: Schema.String,
  excerpt: Schema.String,
}).annotate({ identifier: "Mcp.NoteSummary" })

/**
 * `get_*` is allowed to return the single note body, but its display metadata
 * is bounded just like recall. This prevents one abusive title or literature
 * reference from dominating a response that is otherwise a legitimate read.
 */
export interface NoteDetail
  extends Schema.Schema.Type<typeof NoteDetail> {}
export const NoteDetail = Schema.Struct({
  id: Schema.String,
  type: Markdown.NoteType,
  title: Schema.String,
  content: Schema.String,
  reference: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "Mcp.NoteDetail" })

export const NoteListResult = Schema.Struct({
  notes: Schema.Array(NoteSummary),
}).annotate({ identifier: "Mcp.NoteListResult" })

export const NoteResult = Schema.Struct({
  note: Schema.NullOr(NoteDetail),
}).annotate({ identifier: "Mcp.NoteResult" })

export const PendingApprovalResult = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  proposalId: Schema.String,
  summary: Schema.String,
}).annotate({ identifier: "Mcp.PendingApprovalResult" })
export type PendingApprovalResult = Schema.Schema.Type<typeof PendingApprovalResult>

export const WriteNoteResult = Schema.Union([Note.Info, PendingApprovalResult])
  .annotate({ identifier: "Mcp.WriteNoteResult" })
export type WriteNoteResult = Schema.Schema.Type<typeof WriteNoteResult>

export const DeleteNoteResult = PendingApprovalResult
  .annotate({ identifier: "Mcp.DeleteNoteResult" })
export type DeleteNoteResult = Schema.Schema.Type<typeof DeleteNoteResult>

export const SearchHit = Schema.Struct({
  ...NoteSummary.fields,
  reference: Schema.optional(Schema.String),
}).annotate({ identifier: "Mcp.SearchHit" })
export type SearchHit = Schema.Schema.Type<typeof SearchHit>

export const SearchNotesResult = Schema.Struct({
  query: Schema.String,
  notes: Schema.Array(SearchHit),
}).annotate({ identifier: "Mcp.SearchNotesResult" })

export const TagExample = Schema.Struct({
  id: Schema.String,
  type: Markdown.NoteType,
  title: Schema.String,
}).annotate({ identifier: "Mcp.TagExample" })

export const TagSummaryResult = Schema.Struct({
  tag: Schema.String,
  noteCount: Schema.Int,
  examples: Schema.Array(TagExample),
}).annotate({ identifier: "Mcp.TagSummaryResult" })

export const ListTagsResult = Schema.Struct({
  tags: Schema.Array(TagSummaryResult),
}).annotate({ identifier: "Mcp.ListTagsResult" })

export const ToolFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "Mcp.ToolFailure" })

export type ToolFailure = Schema.Schema.Type<typeof ToolFailure>

export const MAX_LIST_LIMIT = Markdown.MAX_SEARCH_LIMIT
export const DEFAULT_LIST_LIMIT = Markdown.DEFAULT_SEARCH_LIMIT
export const DEFAULT_TAG_LIST_LIMIT = 50
export const MAX_TAG_LIST_LIMIT = 200
export const MAX_TAG_EXAMPLES = 3
export const MAX_EXCERPT_LENGTH = 240
export const MAX_TITLE_LENGTH = 200
export const MAX_REFERENCE_LENGTH = 240
export const MAX_WIKI_EXCERPT_LENGTH = 500

/**
 * Collapses whitespace and truncates untrusted display text. The ellipsis is
 * part of the bound, so callers can rely on `length <= maxLength`.
 */
export const boundedText = (text: string, maxLength: number): string => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLength) {
    return collapsed
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/** Collapses whitespace so an excerpt cannot smuggle a large note body out. */
export const boundedExcerpt = (
  text: string,
  maxLength: number = MAX_EXCERPT_LENGTH,
): string => boundedText(text, maxLength)

/** Bounds a note title in list, search, tag, and detail responses. */
export const boundedTitle = (title: string): string =>
  boundedText(title, MAX_TITLE_LENGTH)

/** Bounds a literature reference in search and detail responses. */
export const boundedReference = (reference: string): string =>
  boundedText(reference, MAX_REFERENCE_LENGTH)

export interface NoteSummarySource {
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly path: string
}

/** The single projection used by every list tool. */
export const noteSummary = (source: NoteSummarySource): NoteSummary => ({
  id: source.id,
  type: source.type,
  title: boundedTitle(source.title),
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
  path: source.path,
  excerpt: boundedExcerpt(source.content),
})

export interface NoteDetailSource {
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** The single projection used by the per-kind get tools. */
export const noteDetail = (source: NoteDetailSource): NoteDetail => ({
  id: source.id,
  type: source.type,
  title: boundedTitle(source.title),
  content: source.content,
  ...(source.reference === undefined
    ? {}
    : { reference: boundedReference(source.reference) }),
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
})

/** Bounded list/search limit: default 10, hard maximum 50. */
export const boundedListLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)))
}

export const boundedTagLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TAG_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_TAG_LIST_LIMIT, Math.trunc(limit)))
}

export const boundedWikiLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return Markdown.DEFAULT_WIKI_LIMIT
  }
  return Math.max(1, Math.min(Markdown.MAX_WIKI_LIMIT, Math.trunc(limit)))
}
