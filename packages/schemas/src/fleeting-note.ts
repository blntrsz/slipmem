export * as FleetingNote from "./fleeting-note.js"

import { Effect, Schema } from "effect"
import { MemoryScope } from "./memory-scope.js"
import { Provenance } from "./provenance.js"

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

// Scope and provenance are optional on write inputs for compatibility with
// callers that predate the scoped-memory contract. The persistence layer
// resolves them to the default scope and the `unknown` provenance. They are
// required on stored Info so every row has one authoritative namespace and a
// provenance record.
const OptionalScope = Schema.optionalKey(MemoryScope.Scope)
const OptionalProvenance = Schema.optionalKey(Provenance.Info)

// Decoding defaults keep pre-scope JSON readable. Rows migrated from the old
// schema were explicitly assigned the legacy provenance by the migration, so
// these defaults are only a safety net for in-memory fixtures and old clients.
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
}).annotate({ identifier: "FleetingNote.Info" })

// Create input only carries user-authored fields. The persistence layer
// generates the id and timestamps, so callers cannot choose them.
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  title: RequiredTitle,
  content: RequiredContent,
  scope: OptionalScope,
  provenance: OptionalProvenance,
}).annotate({ identifier: "FleetingNote.CreateInput" })

export interface GetInput extends Schema.Schema.Type<typeof GetInput> {}
export const GetInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "FleetingNote.GetInput" })

// Every read is partitioned by scope. Omitting it selects the default scope,
// which is the namespace pre-scope notes were migrated into.
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  scope: OptionalScope,
}).annotate({ identifier: "FleetingNote.ListInput" })

// Update input still needs the id to locate the note, but timestamps are
// managed by the persistence layer and are not accepted from callers.
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
// `scope` locates the note; it does not move it. A note cannot change scope or
// provenance through an update in this milestone.
export const UpdateInput = Schema.Struct({
  id: ID,
  title: RequiredTitle,
  content: RequiredContent,
  scope: OptionalScope,
}).annotate({ identifier: "FleetingNote.UpdateInput" })

export interface DeleteInput extends Schema.Schema.Type<typeof DeleteInput> {}
export const DeleteInput = Schema.Struct({
  id: ID,
  scope: OptionalScope,
}).annotate({ identifier: "FleetingNote.DeleteInput" })
