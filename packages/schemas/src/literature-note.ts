export * as LiteratureNote from "./literature-note.js"

import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("LiteratureNote.ID"),
  Schema.annotate({ identifier: "LiteratureNote.ID" }),
)
export type ID = typeof ID.Type

const Title = Schema.String
const Content = Schema.String.check(
  Schema.isMaxLength(5000, {
    message: "Content must be 5000 characters or fewer.",
  }),
)
// Literature notes must point back at the source they were taken from.
const Reference = Schema.String

const RequiredTitle = Title.check(
  Schema.isPattern(/\S/, { message: "Title is required." }),
)
const RequiredContent = Content.check(
  Schema.isPattern(/\S/, { message: "Content is required." }),
)
const RequiredReference = Reference.check(
  Schema.isPattern(/\S/, {
    message: "Reference is required for literature notes.",
  }),
)

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  title: Title,
  content: Content,
  reference: Reference,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "LiteratureNote.Info" })

// Create input only carries user-authored fields. The database generates the
// id and timestamps, so callers cannot choose them.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  title: RequiredTitle,
  content: RequiredContent,
  reference: RequiredReference,
}).annotate({ identifier: "LiteratureNote.CreateInput" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "LiteratureNote.GetInput" })

// Lists are currently unfiltered. Keep an explicit empty input so every
// operation has a schema and filters can be added without changing signatures.
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({}).annotate({ identifier: "LiteratureNote.ListInput" })

// Update input still needs the id to locate the note, but timestamps are
// managed by the database and are not accepted from callers.
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  id: ID,
  title: RequiredTitle,
  content: RequiredContent,
  reference: RequiredReference,
}).annotate({ identifier: "LiteratureNote.UpdateInput" })

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
}).annotate({ identifier: "LiteratureNote.DeleteInput" })
