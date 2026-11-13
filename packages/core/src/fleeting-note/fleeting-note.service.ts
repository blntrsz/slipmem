import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Context, Data, Effect, Option } from "effect"

export class FleetingNoteNotFound extends Data.TaggedError("FleetingNoteNotFound")<{
  readonly id: FleetingNote.ID
}> {}

// Callers must validate untrusted input with the operation's FleetingNote input
// schema before using this service.
export interface FleetingNoteShape {
  readonly create: (input: FleetingNote.CreateInput) => Effect.Effect<FleetingNote.Info>
  readonly get: (input: FleetingNote.GetInput) => Effect.Effect<Option.Option<FleetingNote.Info>>
  readonly list: (input: FleetingNote.ListInput) => Effect.Effect<ReadonlyArray<FleetingNote.Info>>
  readonly update: (input: FleetingNote.UpdateInput) => Effect.Effect<FleetingNote.Info, FleetingNoteNotFound>
  readonly delete: (input: FleetingNote.DeleteInput) => Effect.Effect<boolean>
}

export class FleetingNoteService extends Context.Service<FleetingNoteService, FleetingNoteShape>()(
  "@slipmem/core/FleetingNoteService",
) {}
