export * as FleetingNote from "./fleeting-note.js"

import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("FleetingNote.ID"),
  Schema.annotate({ identifier: "FleetingNote.ID" }),
)
export type ID = typeof ID.Type

const Title = Schema.String
const Content = Schema.String.check(
  Schema.isMaxLength(1000, {
    message: "Content must be 1000 characters or fewer.",
  }),
)

// Write inputs reject whitespace-only values so the UI, HTTP API, and MCP
// tools agree on what an empty field means. Stored Info stays permissive so
// existing databases with older rows remain readable.
const RequiredTitle = Title.check(
  Schema.isPattern(/\S/, { message: "Title is required." }),
)
const RequiredContent = Content.check(
  Schema.isPattern(/\S/, { message: "Content is required." }),
)

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  title: Title,
  content: Content,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "FleetingNote.Info" })

// Create input only carries user-authored fields. The database generates the
// id and timestamps, so callers cannot choose them.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  title: RequiredTitle,
  content: RequiredContent,
}).annotate({ identifier: "FleetingNote.CreateInput" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "FleetingNote.GetInput" })

// Lists are currently unfiltered. Keep an explicit empty input so every
// operation has a schema and filters can be added without changing signatures.
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({}).annotate({ identifier: "FleetingNote.ListInput" })

// Update input still needs the id to locate the note, but timestamps are
// managed by the database and are not accepted from callers.
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  id: ID,
  title: RequiredTitle,
  content: RequiredContent,
}).annotate({ identifier: "FleetingNote.UpdateInput" })

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "FleetingNote.DeleteInput" })
