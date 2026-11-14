import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Provenance } from "@slipmem/schemas/provenance"
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
    createValues: (input) => ({
      title: input.title,
      content: input.content,
    }),
    updateValues: ({ title, content }) => ({ title, content }),
    toInfo: (row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      scope: row.scope,
      provenance: Provenance.decode(row.provenance),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    notFound: (id) => new FleetingNoteNotFound({ id }),
  }).pipe(Effect.map(FleetingNoteService.of)),
)
