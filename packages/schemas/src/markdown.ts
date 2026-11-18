export * as Markdown from "./markdown.js"

import { Schema } from "effect"

// Phase 0 contract: the Markdown repository is the source of truth. These
// constants and pure helpers are the single definition of filenames, tag
// slugs, metadata, approval proposals, and structured wiki output. The
// repository, CLI, MCP, and web surfaces must import them rather than
// reimplementing the rules.
//
// The schemas in this module validate wire and metadata shapes. They are not a
// serializer: decoding a struct drops unknown frontmatter keys, so the
// repository parser must keep the raw unknown mapping separately and write it
// back on render. Decoding here never replaces that round-trip guarantee.
export const SCHEMA_VERSION = 1

export const MAX_SLUG_LENGTH = 80
export const MAX_TAG_LENGTH = 64

export const NOTE_FILENAME_PATTERN = /^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
export const NOTE_ID_PATTERN = /^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const TAG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export const NOTE_TYPES = ["fleeting", "permanent", "literature"] as const
export const NoteType = Schema.Literals(NOTE_TYPES)
export type NoteType = typeof NoteType.Type

export const CONTENT_LIMITS = {
  fleeting: 1000,
  permanent: 2000,
  literature: 5000,
} as const

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 50
export const DEFAULT_WIKI_LIMIT = 10
export const MAX_WIKI_LIMIT = 25
export const MAX_NOTE_FILE_BYTES = 1024 * 1024

// Only ASCII lowercase, digits, and single hyphens are allowed in both note
// filename segments and tag slugs. Unicode is decomposed and stripped of
// combining marks before the ASCII filter, so "Café" becomes "cafe" instead of
// disappearing entirely.
const toAsciiSlug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const truncateSlug = (slug: string, maxLength: number): string => {
  if (slug.length <= maxLength) {
    return slug
  }

  const head = slug.slice(0, maxLength)
  const boundary = head.lastIndexOf("-")
  const truncated = boundary > 0 ? head.slice(0, boundary) : head
  return truncated.replace(/-+$/g, "")
}

/**
 * Converts a display title into the creation-time filename slug.
 *
 * The 80-character limit is applied after normalization. When possible the
 * slug is cut on a hyphen boundary; a title with a single token longer than the
 * limit is hard-cut. An empty result becomes `untitled`.
 */
export const slugifyTitle = (title: string): string =>
  truncateSlug(toAsciiSlug(title), MAX_SLUG_LENGTH) || "untitled"

/**
 * Normalizes a tag for frontmatter and wiki routing.
 *
 * Tags use the same ASCII kebab-case pipeline as note slugs, with a
 * 64-character limit. Unlike titles there is no `untitled` fallback: a value
 * that normalizes to nothing is not a usable tag and returns the empty
 * string so callers can reject it.
 */
export const slugifyTag = (tag: string): string =>
  truncateSlug(toAsciiSlug(tag), MAX_TAG_LENGTH)

export const isTagSlug = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_TAG_LENGTH &&
  TAG_SLUG_PATTERN.test(value)

export interface UtcTimestamp {
  /** `YYYYMMDDHHmmss`, the 14-digit filename prefix. */
  readonly filenamePrefix: string
  /** ISO 8601 UTC with whole seconds, for frontmatter. */
  readonly isoTimestamp: string
}

/**
 * Converts epoch milliseconds or a `Date` to the two timestamp forms used by
 * the storage contract. Milliseconds are truncated, never rounded, so a
 * filename prefix and its `createdAt` always agree.
 */
export const toUtcTimestamp = (value: Date | number): UtcTimestamp => {
  const date = typeof value === "number" ? new Date(value) : value
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(value)}`)
  }

  const iso = date.toISOString()
  return {
    filenamePrefix: `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`,
    isoTimestamp: `${iso.slice(0, 19)}Z`,
  }
}

/** Parses a 14-digit filename prefix, rejecting impossible UTC dates. */
export const parseUtcPrefix = (prefix: string): Date | null => {
  if (!/^\d{14}$/.test(prefix)) {
    return null
  }

  const year = Number(prefix.slice(0, 4))
  const month = Number(prefix.slice(4, 6))
  const day = Number(prefix.slice(6, 8))
  const hour = Number(prefix.slice(8, 10))
  const minute = Number(prefix.slice(10, 12))
  const second = Number(prefix.slice(12, 14))
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null
  }

  return date
}

/**
 * True when a canonical UTC timestamp names a real calendar instant.
 *
 * The regex alone accepts impossible values such as `2026-02-30T19:30:45Z` or
 * `2026-11-17T25:00:00Z`; the schema contract rejects those.
 */
export const isUtcTimestamp = (value: string): boolean =>
  UTC_TIMESTAMP_PATTERN.test(value) &&
  parseUtcPrefix(value.replace(/[-:TZ]/g, "")) !== null

/** True when a note ID starts with a real UTC timestamp prefix. */
export const isNoteIdWithRealTimestamp = (id: string): boolean =>
  NOTE_ID_PATTERN.test(id) && parseUtcPrefix(id.slice(0, 14)) !== null

export const isNoteFilename = (filename: string): boolean =>
  NOTE_FILENAME_PATTERN.test(filename)

export const isNoteId = (id: string): boolean => NOTE_ID_PATTERN.test(id)

export const noteIdFromFilename = (filename: string): string | null =>
  isNoteFilename(filename) ? filename.slice(0, -".md".length) : null

export interface NoteFilenameInput {
  readonly title: string
  /** Creation time in epoch milliseconds or a UTC `Date`. */
  readonly createdAt: Date | number
  /** Existing filenames, including the target directory. */
  readonly taken?: Iterable<string>
}

/**
 * Builds a note filename and resolves same-second title collisions with a
 * numeric suffix. The 14-digit creation prefix never changes.
 */
export const noteFilename = ({ title, createdAt, taken }: NoteFilenameInput): string => {
  const { filenamePrefix } = toUtcTimestamp(createdAt)
  const slug = slugifyTitle(title)
  const filenames = new Set(taken ?? [])
  const first = `${filenamePrefix}-${slug}.md`

  if (!filenames.has(first)) {
    return first
  }

  for (let suffix = 2; ; suffix++) {
    const candidate = `${filenamePrefix}-${slug}-${suffix}.md`
    if (!filenames.has(candidate)) {
      return candidate
    }
  }
}

const isNonBlank = (message: string) =>
  Schema.isPattern(/\S/, { message })

const NonBlankString = (message: string) => Schema.String.check(isNonBlank(message))

export const NoteId = Schema.String.check(
  Schema.isPattern(NOTE_ID_PATTERN, {
    message: "Note ID must be a 14-digit UTC timestamp plus a kebab-case slug.",
  }),
  Schema.makeFilter(
    (value: string) => parseUtcPrefix(value.slice(0, 14)) !== null,
    { message: "Note ID timestamp must be a real UTC date and time." },
  ),
).annotate({ identifier: "Markdown.NoteId" })

export const TagSlug = Schema.String.check(
  Schema.isPattern(TAG_SLUG_PATTERN, {
    message: "Tags must be lowercase kebab-case slugs.",
  }),
  Schema.isMaxLength(MAX_TAG_LENGTH, {
    message: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
  }),
).annotate({ identifier: "Markdown.TagSlug" })

export const Timestamp = Schema.String.check(
  Schema.isPattern(UTC_TIMESTAMP_PATTERN, {
    message: "Timestamps must be ISO 8601 UTC with whole seconds.",
  }),
  Schema.makeFilter((value: string) => isUtcTimestamp(value), {
    message: "Timestamps must name a real UTC date and time.",
  }),
).annotate({ identifier: "Markdown.Timestamp" })

export interface Provenance extends Schema.Schema.Type<typeof Provenance> {}
export const Provenance = Schema.Struct({
  source: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.String),
}).annotate({ identifier: "Markdown.Provenance" })

export interface NoteMetadata extends Schema.Schema.Type<typeof NoteMetadata> {}
export const NoteMetadata = Schema.Struct({
  schema: Schema.Literal(SCHEMA_VERSION),
  id: NoteId,
  type: NoteType,
  title: Schema.String.check(
    Schema.isPattern(/\S/, { message: "Title is required." }),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  tags: Schema.optional(Schema.Array(TagSlug)),
  reference: Schema.optional(NonBlankString("Reference must not be blank.")),
  provenance: Schema.optional(Provenance),
  legacyId: Schema.optional(Schema.String),
  aliases: Schema.optional(Schema.Array(Schema.String)),
}).check(
  Schema.makeFilter(
    (metadata: {
      readonly type: NoteType
      readonly createdAt: string
      readonly updatedAt: string
      readonly reference?: string
    }) => {
      const issues: Array<{ readonly path: ReadonlyArray<PropertyKey>; readonly issue: string }> = []
      if (metadata.updatedAt < metadata.createdAt) {
        issues.push({
          path: ["updatedAt"],
          issue: "updatedAt must not be earlier than createdAt.",
        })
      }
      if (metadata.type === "literature" && metadata.reference === undefined) {
        issues.push({
          path: ["reference"],
          issue: "Literature notes require a non-whitespace reference.",
        })
      }
      return issues
    },
  ),
).annotate({ identifier: "Markdown.NoteMetadata" })

export const ApprovalOperation = Schema.Literals([
  "create",
  "update",
  "delete",
  "reclassify",
])
export type ApprovalOperation = typeof ApprovalOperation.Type

// A proposal always targets one note file and names its ID. `operation` then
// decides the rest: creates carry full content, updates/reclassifications bind
// to a base hash and full content, deletes bind to a base hash and never carry
// replacement content.
const approvalTarget = {
  id: NonBlankString("Proposal ID is required."),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  noteId: NoteId,
  path: NonBlankString("Proposal target path is required."),
  actor: Schema.optional(NonBlankString("Proposal actor must not be blank.")),
  source: Schema.Literal("mcp"),
  summary: NonBlankString("Proposal summary is required."),
}

const approvalTiming = Schema.makeFilter(
  (proposal: { readonly createdAt: string; readonly expiresAt: string }) =>
    proposal.expiresAt < proposal.createdAt
      ? "Proposal expiry must not be earlier than its creation time."
      : undefined,
)

const CreateApprovalProposal = Schema.Struct({
  ...approvalTarget,
  operation: Schema.Literal("create"),
  baseHash: Schema.optional(NonBlankString("Base hash must not be blank.")),
  content: NonBlankString("Created note content is required."),
}).check(approvalTiming)

const UpdateApprovalProposal = Schema.Struct({
  ...approvalTarget,
  operation: Schema.Literal("update"),
  baseHash: NonBlankString("Update proposals require a base content hash."),
  content: NonBlankString("Update proposals require full note content."),
}).check(approvalTiming)

const DeleteApprovalProposal = Schema.Struct({
  ...approvalTarget,
  operation: Schema.Literal("delete"),
  baseHash: NonBlankString("Delete proposals require a base content hash."),
}).check(approvalTiming)

const ReclassifyApprovalProposal = Schema.Struct({
  ...approvalTarget,
  operation: Schema.Literal("reclassify"),
  baseHash: NonBlankString("Reclassify proposals require a base content hash."),
  content: NonBlankString("Reclassify proposals require full note content."),
}).check(approvalTiming)

export type ApprovalProposal = Schema.Schema.Type<typeof ApprovalProposal>
export const ApprovalProposal = Schema.Union([
  CreateApprovalProposal,
  UpdateApprovalProposal,
  DeleteApprovalProposal,
  ReclassifyApprovalProposal,
]).annotate({ identifier: "Markdown.ApprovalProposal" })

export const WikiMode = Schema.Literals(["extractive", "synthesized"])
export type WikiMode = typeof WikiMode.Type

export interface WikiInput extends Schema.Schema.Type<typeof WikiInput> {}
export const WikiInput = Schema.Struct({
  tag: TagSlug,
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween(
        { minimum: 1, maximum: MAX_WIKI_LIMIT },
        { message: `Wiki limit must be between 1 and ${MAX_WIKI_LIMIT}.` },
      ),
    ),
  ),
  mode: Schema.optional(WikiMode),
  includeFleeting: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Markdown.WikiInput" })

export interface WikiCitation extends Schema.Schema.Type<typeof WikiCitation> {}
export const WikiCitation = Schema.Struct({
  noteId: NoteId,
  path: NonBlankString("Citation path is required."),
  excerpt: Schema.optional(NonBlankString("Citation excerpt must not be blank.")),
}).annotate({ identifier: "Markdown.WikiCitation" })

// Every factual section must cite at least one note. Headings and prose are
// required so a section cannot be an empty citation container or uncited
// filler.
export interface WikiSection extends Schema.Schema.Type<typeof WikiSection> {}
export const WikiSection = Schema.Struct({
  heading: NonBlankString("Section heading is required."),
  markdown: NonBlankString("Section markdown is required."),
  citations: Schema.Array(WikiCitation).check(
    Schema.isMinLength(1, {
      message: "Every wiki section must cite at least one note.",
    }),
  ),
}).annotate({ identifier: "Markdown.WikiSection" })

export interface WikiSource extends Schema.Schema.Type<typeof WikiSource> {}
export const WikiSource = Schema.Struct({
  id: NoteId,
  path: NonBlankString("Source path is required."),
  type: NoteType,
  title: NonBlankString("Source title is required."),
  updatedAt: Timestamp,
}).annotate({ identifier: "Markdown.WikiSource" })

// Structured wiki output is canonical. `markdown` is a rendering of the same
// sections for CLI and copy/paste use, never a second source of truth.
export interface WikiPage extends Schema.Schema.Type<typeof WikiPage> {}
export const WikiPage = Schema.Struct({
  tag: TagSlug,
  generatedAt: Timestamp,
  mode: WikiMode,
  noteCount: Schema.Int.check(
    Schema.isBetween(
      { minimum: 0, maximum: MAX_WIKI_LIMIT },
      { message: `Wiki note count must be between 0 and ${MAX_WIKI_LIMIT}.` },
    ),
  ),
  sources: Schema.Array(WikiSource),
  sections: Schema.Array(WikiSection),
  markdown: Schema.String,
}).annotate({ identifier: "Markdown.WikiPage" })
