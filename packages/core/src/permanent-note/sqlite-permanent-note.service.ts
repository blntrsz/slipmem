import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Effect, Layer } from "effect"
import { PermanentNoteNotFound, PermanentNoteService } from "./permanent-note.service"
import { PermanentNoteTable } from "./permanent-note.sql"
import { makeSQLiteNoteOperations } from "../sqlite-note-operations"

export const SQLitePermanentNoteService = Layer.effect(
  PermanentNoteService,
  makeSQLiteNoteOperations<
    typeof PermanentNoteTable,
    PermanentNote.ID,
    PermanentNote.Info,
    PermanentNote.CreateInput,
    PermanentNote.UpdateInput,
    PermanentNoteNotFound
  >({
    table: PermanentNoteTable,
    createValues: (input) => input,
    updateValues: ({ id: _id, ...changes }) => changes,
    toInfo: (row) => row,
    notFound: (id) => new PermanentNoteNotFound({ id }),
  }).pipe(Effect.map(PermanentNoteService.of)),
)
