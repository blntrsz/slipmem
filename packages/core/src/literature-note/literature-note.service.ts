import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Context, Data, Effect, Option } from "effect"

export class LiteratureNoteNotFound extends Data.TaggedError("LiteratureNoteNotFound")<{
  readonly id: LiteratureNote.ID
}> {}

// Callers must validate untrusted input with the operation's LiteratureNote
// input schema before using this service.
export interface LiteratureNoteShape {
  readonly create: (input: LiteratureNote.CreateInput) => Effect.Effect<LiteratureNote.Info>
  readonly get: (input: LiteratureNote.GetInput) => Effect.Effect<Option.Option<LiteratureNote.Info>>
  readonly list: (input: LiteratureNote.ListInput) => Effect.Effect<ReadonlyArray<LiteratureNote.Info>>
  readonly update: (input: LiteratureNote.UpdateInput) => Effect.Effect<LiteratureNote.Info, LiteratureNoteNotFound>
  readonly delete: (input: LiteratureNote.DeleteInput) => Effect.Effect<boolean>
}

export class LiteratureNoteService extends Context.Service<LiteratureNoteService, LiteratureNoteShape>()(
  "@slipmem/core/LiteratureNoteService",
) {}
