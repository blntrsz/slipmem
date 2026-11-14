import { Effect, Layer } from "effect"
import { FleetingNoteService } from "../fleeting-note/fleeting-note.service"
import { LiteratureNoteService } from "../literature-note/literature-note.service"
import { PermanentNoteService } from "../permanent-note/permanent-note.service"
import { NoteService } from "./note.service"

// Combines the three note slices into one read-only view. Writes stay on the
// per-slice services because each note kind has its own input schema.
//
// Notes are returned grouped by kind in a stable order (fleeting, literature,
// permanent), preserving each service's list order within its group.
export const CombinedNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const fleeting = yield* FleetingNoteService
    const literature = yield* LiteratureNoteService
    const permanent = yield* PermanentNoteService

    return NoteService.of({
      list: (_input) => Effect.gen(function* () {
        const { fleetingNotes, literatureNotes, permanentNotes } = yield* Effect.all({
          fleetingNotes: fleeting.list({}),
          literatureNotes: literature.list({}),
          permanentNotes: permanent.list({}),
        })

        // The per-slice services return their plain Info shape, so add the
        // discriminant here to build Note.Info values.
        return [
          ...fleetingNotes.map((note) => ({ type: "fleeting" as const, ...note })),
          ...literatureNotes.map((note) => ({ type: "literature" as const, ...note })),
          ...permanentNotes.map((note) => ({ type: "permanent" as const, ...note })),
        ]
      }),
    })
  }),
)
