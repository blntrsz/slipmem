export * as LiteratureNote from "./literature-note.js"

import { Effect, Schema } from "effect"
import { MemoryScope } from "./memory-scope.js"
import { Provenance } from "./provenance.js"

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

const OptionalScope = Schema.optionalKey(MemoryScope.Scope)
const OptionalProvenance = Schema.optionalKey(Provenance.Info)

const InfoScope = MemoryScope.Scope.pipe(
  Schema.withDecodingDefaultType(Effect.succeed(MemoryScope.DEFAULT_SCOPE)),
)
const InfoProvenance = Provenance.Info.pipe(
  Schema.withDecodingDefaultType(Effect.succeed(Provenance.LEGACY)),
)

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  title: Title,
  content: Content,
  reference: Reference,
  scope: InfoScope,
  provenance: InfoProvenance,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "LiteratureNote.Info" })

// Create input only carries user-authored fields. The persistence layer
// generates the id and timestamps, so callers cannot choose them.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  title: RequiredTitle,
  content: RequiredContent,
  reference: RequiredReference,
  scope: OptionalScope,
  provenance: OptionalProvenance,
}).annotate({ identifier: "LiteratureNote.CreateInput" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "LiteratureNote.GetInput" })

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  scope: OptionalScope,
}).annotate({ identifier: "LiteratureNote.ListInput" })

// Update input still needs the id to locate the note, but timestamps, scope,
// and provenance are managed by the persistence layer.
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  id: ID,
  title: RequiredTitle,
  content: RequiredContent,
  reference: RequiredReference,
  scope: OptionalScope,
}).annotate({ identifier: "LiteratureNote.UpdateInput" })

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "LiteratureNote.DeleteInput" })
