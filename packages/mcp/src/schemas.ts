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
  topic: Schema.optional(Schema.String),
}).annotate({ identifier: "Mcp.ListNotesInput" })

export const GetNoteInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Mcp.GetNoteInput" })

const Topics = Schema.optional(Schema.Array(Schema.String))

export const CreateFleetingInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  topics: Topics,
}).annotate({ identifier: "Mcp.CreateFleetingInput" })

export const UpdateFleetingInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  topics: Topics,
}).annotate({ identifier: "Mcp.UpdateFleetingInput" })

export const CreatePermanentInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  topics: Topics,
}).annotate({ identifier: "Mcp.CreatePermanentInput" })

export const UpdatePermanentInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  topics: Topics,
}).annotate({ identifier: "Mcp.UpdatePermanentInput" })

export const CreateLiteratureInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.String,
  topics: Topics,
}).annotate({ identifier: "Mcp.CreateLiteratureInput" })

export const UpdateLiteratureInput = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  reference: Schema.optional(Schema.String),
  topics: Topics,
}).annotate({ identifier: "Mcp.UpdateLiteratureInput" })

export const DeleteNoteInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Mcp.DeleteNoteInput" })

export const SearchNotesInput = Schema.Struct({
  query: Schema.String,
  type: Schema.optional(Markdown.NoteType),
  topic: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Mcp.SearchNotesInput" })

export const ListTopicsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Mcp.ListTopicsInput" })

/**
 * The topic is accepted as display text and normalized by the shared slug
 * pipeline. An input that normalizes to nothing is rejected by the handler.
 */
export const BuildTopicWikiInput = Schema.Struct({
  topic: Schema.String,
  limit: Schema.optional(Schema.Int),
  mode: Schema.optional(Markdown.WikiMode),
  includeFleeting: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Mcp.BuildTopicWikiInput" })

export const NoteListResult = Schema.Struct({
  notes: Schema.Array(Note.Info),
}).annotate({ identifier: "Mcp.NoteListResult" })

export const NoteResult = Schema.Struct({
  note: Schema.NullOr(Note.Info),
}).annotate({ identifier: "Mcp.NoteResult" })

export const PendingApprovalResult = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  proposalId: Schema.String,
  summary: Schema.String,
  expiresAt: Markdown.Timestamp,
}).annotate({ identifier: "Mcp.PendingApprovalResult" })

export const WriteNoteResult = Schema.Union([Note.Info, PendingApprovalResult])
  .annotate({ identifier: "Mcp.WriteNoteResult" })

export const DeleteNoteResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("deleted"),
    id: Schema.String,
    backupPath: Schema.String,
  }),
  PendingApprovalResult,
]).annotate({ identifier: "Mcp.DeleteNoteResult" })

export const SearchHit = Schema.Struct({
  id: Schema.String,
  type: Markdown.NoteType,
  title: Schema.String,
  excerpt: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Mcp.SearchHit" })

export const SearchNotesResult = Schema.Struct({
  query: Schema.String,
  notes: Schema.Array(SearchHit),
}).annotate({ identifier: "Mcp.SearchNotesResult" })

export const TopicExample = Schema.Struct({
  id: Schema.String,
  type: Markdown.NoteType,
  title: Schema.String,
}).annotate({ identifier: "Mcp.TopicExample" })

export const TopicSummaryResult = Schema.Struct({
  topic: Schema.String,
  noteCount: Schema.Int,
  examples: Schema.Array(TopicExample),
}).annotate({ identifier: "Mcp.TopicSummaryResult" })

export const ListTopicsResult = Schema.Struct({
  topics: Schema.Array(TopicSummaryResult),
}).annotate({ identifier: "Mcp.ListTopicsResult" })

export const ToolFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "Mcp.ToolFailure" })

export type ToolFailure = Schema.Schema.Type<typeof ToolFailure>

export const MAX_LIST_LIMIT = Markdown.MAX_SEARCH_LIMIT
export const DEFAULT_LIST_LIMIT = Markdown.DEFAULT_SEARCH_LIMIT
export const DEFAULT_TOPIC_LIST_LIMIT = 50
export const MAX_TOPIC_LIST_LIMIT = 200
export const MAX_TOPIC_EXAMPLES = 3
export const MAX_EXCERPT_LENGTH = 240
export const MAX_WIKI_EXCERPT_LENGTH = 500

/** Bounded list/search limit: default 10, hard maximum 50. */
export const boundedListLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)))
}

export const boundedTopicLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TOPIC_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_TOPIC_LIST_LIMIT, Math.trunc(limit)))
}

export const boundedWikiLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return Markdown.DEFAULT_WIKI_LIMIT
  }
  return Math.max(1, Math.min(Markdown.MAX_WIKI_LIMIT, Math.trunc(limit)))
}

/** Collapses whitespace so an excerpt cannot smuggle a large note body out. */
export const boundedExcerpt = (
  text: string,
  maxLength: number = MAX_EXCERPT_LENGTH,
): string => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLength) {
    return collapsed
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
