export * as FleetingNote from "./fleeting-note.js"

import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("FleetingNote.ID"),
  Schema.annotate({ identifier: "FleetingNote.ID" }),
)
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  content: Schema.String.check(Schema.isMaxLength(1000)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "FleetingNote.Info" })

// Create and update take a complete note so the service can persist it without
// converting fields.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Info.pipe(
  Schema.annotate({ identifier: "FleetingNote.CreateInput" }),
)

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "FleetingNote.GetInput" })

// Lists are currently unfiltered. Keep an explicit empty input so every
// operation has a schema and filters can be added without changing signatures.
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({}).annotate({ identifier: "FleetingNote.ListInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Info.pipe(
  Schema.annotate({ identifier: "FleetingNote.UpdateInput" }),
)

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "FleetingNote.DeleteInput" })
