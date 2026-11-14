import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Provenance } from "@slipmem/schemas/provenance"
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
    createValues: (input) => ({
      title: input.title,
      content: input.content,
      reference: input.reference,
    }),
    updateValues: ({ title, content, reference }) => ({
      title,
      content,
      reference,
    }),
    toInfo: (row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      reference: row.reference,
      scope: row.scope,
      provenance: Provenance.decode(row.provenance),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    notFound: (id) => new LiteratureNoteNotFound({ id }),
  }).pipe(Effect.map(LiteratureNoteService.of)),
)
