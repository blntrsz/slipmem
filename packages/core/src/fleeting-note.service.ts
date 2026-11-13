import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Context, Data, Effect, Option } from "effect"

export class FleetingNoteError extends Data.TaggedError("FleetingNoteError")<{
  readonly cause: unknown
}> {}

export interface FleetingNoteShape {
  readonly create: (note: FleetingNote.Info) => Effect.Effect<FleetingNote.Info, FleetingNoteError>
  readonly get: (id: FleetingNote.ID) => Effect.Effect<Option.Option<FleetingNote.Info>, FleetingNoteError>
  readonly list: () => Effect.Effect<ReadonlyArray<FleetingNote.Info>, FleetingNoteError>
  readonly update: (note: FleetingNote.Info) => Effect.Effect<Option.Option<FleetingNote.Info>, FleetingNoteError>
  readonly delete: (id: FleetingNote.ID) => Effect.Effect<boolean, FleetingNoteError>
}

export class FleetingNoteService extends Context.Service<FleetingNoteService, FleetingNoteShape>()(
  "@slipmem/core/FleetingNoteService",
) {}
