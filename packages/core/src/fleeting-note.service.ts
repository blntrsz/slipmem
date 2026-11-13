import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Context, Data, Effect, Option } from "effect"

export class FleetingNoteNotFound extends Data.TaggedError("FleetingNoteNotFound")<{
  readonly id: FleetingNote.ID
}> {}

// Callers must validate untrusted input with FleetingNote.Info before using this service.
export interface FleetingNoteShape {
  readonly create: (note: FleetingNote.Info) => Effect.Effect<FleetingNote.Info>
  readonly get: (id: FleetingNote.ID) => Effect.Effect<Option.Option<FleetingNote.Info>>
  readonly list: () => Effect.Effect<ReadonlyArray<FleetingNote.Info>>
  readonly update: (note: FleetingNote.Info) => Effect.Effect<FleetingNote.Info, FleetingNoteNotFound>
  readonly delete: (id: FleetingNote.ID) => Effect.Effect<boolean>
}

export class FleetingNoteService extends Context.Service<FleetingNoteService, FleetingNoteShape>()(
  "@slipmem/core/FleetingNoteService",
) {}
