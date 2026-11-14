import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Effect, Layer } from "effect"
import { LiteratureNoteNotFound, LiteratureNoteService } from "./literature-note.service"
import { LiteratureNoteTable } from "./literature-note.sql"
import { makeSQLiteNoteOperations } from "../sqlite-note-operations"

export const SQLiteLiteratureNoteService = Layer.effect(
  LiteratureNoteService,
  makeSQLiteNoteOperations<
    typeof LiteratureNoteTable,
    LiteratureNote.ID,
    LiteratureNote.Info,
    LiteratureNote.CreateInput,
    LiteratureNote.UpdateInput,
    LiteratureNoteNotFound
  >({
    table: LiteratureNoteTable,
    createValues: (input) => input,
    updateValues: ({ id: _id, ...changes }) => changes,
    toInfo: (row) => row,
    notFound: (id) => new LiteratureNoteNotFound({ id }),
  }).pipe(Effect.map(LiteratureNoteService.of)),
)
