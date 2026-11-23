export * as Note from "./note.js"

import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note.js"
import { LiteratureNote } from "./literature-note.js"
import { Markdown } from "./markdown.js"
import { PermanentNote } from "./permanent-note.js"

// Every note kind is exposed through one discriminated union so callers that
// only care about "a note" do not need to know which slice it came from. The
// discriminant values match the schema module names.
export const Kind = Schema.Literals(["fleeting", "literature", "permanent"])
export type Kind = typeof Kind.Type

// Each variant reuses the slice's Info fields and adds the discriminant, so
// the union cannot drift from the per-slice schemas.
export interface FleetingInfo extends Schema.Schema.Type<typeof FleetingInfo> {}
export const FleetingInfo = Schema.Struct({
  type: Schema.Literal("fleeting"),
  ...FleetingNote.Info.fields,
}).annotate({ identifier: "Note.FleetingInfo" })

export interface LiteratureInfo extends Schema.Schema.Type<typeof LiteratureInfo> {}
export const LiteratureInfo = Schema.Struct({
  type: Schema.Literal("literature"),
  ...LiteratureNote.Info.fields,
}).annotate({ identifier: "Note.LiteratureInfo" })

export interface PermanentInfo extends Schema.Schema.Type<typeof PermanentInfo> {}
export const PermanentInfo = Schema.Struct({
  type: Schema.Literal("permanent"),
  ...PermanentNote.Info.fields,
}).annotate({ identifier: "Note.PermanentInfo" })

// `type` is the discriminant, so the union carries `match`, `guards`, and
// `isAnyOf` helpers in addition to the schema itself.
export const Info = Schema.Union([FleetingInfo, LiteratureInfo, PermanentInfo])
  .annotate({ identifier: "Note.Info" })
  .pipe(Schema.toTaggedUnion("type"))
export type Info = typeof Info.Type

// The wire shape shared by the web form and the JSON API. Per-kind schemas
// still validate the actual create/update input: this draft only describes
// fields a caller may send before the kind-specific rules are applied.
export interface Draft extends Schema.Schema.Type<typeof Draft> {}
export const Draft = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.optional(Schema.String),
  // Always present in web form payloads: an explicit empty array clears tags
  // on update instead of meaning "preserve the existing metadata".
  tags: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Note.Draft" })

// Lists are bounded even though they take no filters. The SQLite and Markdown
// NoteService implementations share these bounds so switching storage cannot
// silently change how many notes a caller sees. A `limit` overrides the default
// and is clamped to the maximum by the service.
export const DEFAULT_LIST_LIMIT = Markdown.DEFAULT_SEARCH_LIMIT
export const MAX_LIST_LIMIT = Markdown.MAX_SEARCH_LIMIT

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Note.ListInput" })

export interface ListTitlesInput extends Schema.Schema.Type<typeof ListTitlesInput> {}
export const ListTitlesInput = Schema.Struct({
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Note.ListTitlesInput" })

// A search can match any text field a note has. Literature notes add
// `reference`; kinds without one simply never match that field. Tags are note
// metadata rather than body text, so they are a searchable field in their own
// right.
export const SearchField = Schema.Literals([
  "title",
  "content",
  "reference",
  "tags",
])
export type SearchField = typeof SearchField.Type

// The fields every NoteService backend can search when the caller omits
// `fields`. `tags` is deliberately not in this shared default: the Markdown
// backend stores tags, but SQLite note rows have no tag column, so making tags
// part of the default would make the two services return different notes for
// the same query. A caller that wants tag matching must ask for `fields:
// ["tags"]` and accept that a backend without tag storage returns no matches.
export const DEFAULT_SEARCH_FIELDS: ReadonlyArray<SearchField> = [
  "title",
  "content",
  "reference",
]

// Search is cross-kind by default. `fields`, `kinds`, and `limit` are optional
// filters. Omitting `fields` searches `DEFAULT_SEARCH_FIELDS` across every kind
// and applies the service's default result bound. An explicit empty `fields` or
// `kinds` array matches nothing.
export interface SearchInput extends Schema.Schema.Type<typeof SearchInput> {}
export const SearchInput = Schema.Struct({
  query: Schema.String,
  fields: Schema.optional(Schema.Array(SearchField)),
  kinds: Schema.optional(Schema.Array(Kind)),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Note.SearchInput" })

// Title results are intentionally lighter than Info: they carry enough to
// identify a note and render a list without loading its content. The kind is
// needed because ids are only guaranteed to be unique within their own table.
export interface TitleInfo extends Schema.Schema.Type<typeof TitleInfo> {}
export const TitleInfo = Schema.Struct({
  id: Schema.String,
  type: Kind,
  title: Schema.String,
}).annotate({ identifier: "Note.TitleInfo" })
