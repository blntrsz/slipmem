export * as PermanentNote from "./permanent-note.js"

import { Effect, Schema } from "effect"
import { MemoryScope } from "./memory-scope.js"
import { Provenance } from "./provenance.js"

export const ID = Schema.String.pipe(
  Schema.brand("PermanentNote.ID"),
  Schema.annotate({ identifier: "PermanentNote.ID" }),
)
export type ID = typeof ID.Type

const Title = Schema.String
const Content = Schema.String.check(
  Schema.isMaxLength(2000, {
    message: "Content must be 2000 characters or fewer.",
  }),
)

const RequiredTitle = Title.check(
  Schema.isPattern(/\S/, { message: "Title is required." }),
)
const RequiredContent = Content.check(
  Schema.isPattern(/\S/, { message: "Content is required." }),
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
  scope: InfoScope,
  provenance: InfoProvenance,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "PermanentNote.Info" })

// Create input only carries user-authored fields. The persistence layer
// generates the id and timestamps, so callers cannot choose them.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  title: RequiredTitle,
  content: RequiredContent,
  scope: OptionalScope,
  provenance: OptionalProvenance,
}).annotate({ identifier: "PermanentNote.CreateInput" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "PermanentNote.GetInput" })

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  scope: OptionalScope,
}).annotate({ identifier: "PermanentNote.ListInput" })

// Update input still needs the id to locate the note, but timestamps, scope,
// and provenance are managed by the persistence layer.
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  id: ID,
  title: RequiredTitle,
  content: RequiredContent,
  scope: OptionalScope,
}).annotate({ identifier: "PermanentNote.UpdateInput" })

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "PermanentNote.DeleteInput" })
