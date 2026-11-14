import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Effect, Layer } from "effect"
import { FleetingNoteNotFound, FleetingNoteService } from "./fleeting-note.service"
import { FleetingNoteTable } from "./fleeting-note.sql"
import { makeSQLiteNoteOperations } from "../sqlite-note-operations"

export const SQLiteFleetingNoteService = Layer.effect(
  FleetingNoteService,
  makeSQLiteNoteOperations<
    typeof FleetingNoteTable,
    FleetingNote.ID,
    FleetingNote.Info,
    FleetingNote.CreateInput,
    FleetingNote.UpdateInput,
    FleetingNoteNotFound
  >({
    table: FleetingNoteTable,
    createValues: (input) => input,
    updateValues: ({ id: _id, ...changes }) => changes,
    toInfo: (row) => row,
    notFound: (id) => new FleetingNoteNotFound({ id }),
  }).pipe(Effect.map(FleetingNoteService.of)),
)
