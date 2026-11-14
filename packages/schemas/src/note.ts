export * as Note from "./note.js"

import { Schema } from "effect"
import { FleetingNote } from "./fleeting-note.js"
import { LiteratureNote } from "./literature-note.js"
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

// Lists are currently unfiltered. Keep an explicit empty input so every
// operation has a schema and filters can be added without changing signatures.
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({}).annotate({ identifier: "Note.ListInput" })
