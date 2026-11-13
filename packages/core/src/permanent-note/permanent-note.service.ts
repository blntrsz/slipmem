import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Context, Data, Effect, Option } from "effect"

export class PermanentNoteNotFound extends Data.TaggedError("PermanentNoteNotFound")<{
  readonly id: PermanentNote.ID
}> {}

// Callers must validate untrusted input with the operation's PermanentNote input
// schema before using this service.
export interface PermanentNoteShape {
  readonly create: (input: PermanentNote.CreateInput) => Effect.Effect<PermanentNote.Info>
  readonly get: (input: PermanentNote.GetInput) => Effect.Effect<Option.Option<PermanentNote.Info>>
  readonly list: (input: PermanentNote.ListInput) => Effect.Effect<ReadonlyArray<PermanentNote.Info>>
  readonly update: (input: PermanentNote.UpdateInput) => Effect.Effect<PermanentNote.Info, PermanentNoteNotFound>
  readonly delete: (input: PermanentNote.DeleteInput) => Effect.Effect<boolean>
}

export class PermanentNoteService extends Context.Service<PermanentNoteService, PermanentNoteShape>()(
  "@slipmem/core/PermanentNoteService",
) {}
