import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import { NoteService } from "./note.service"

// The three note tables have different shapes, so the union selects the shared
// columns and tags each row with its kind. `reference` is NULL for kinds that
// do not have one.
interface NoteRow {
  readonly id: string
  readonly type: Note.Kind
  readonly title: string
  readonly content: string
  readonly reference: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

const toInfo = (row: NoteRow): Note.Info => {
  switch (row.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: row.id as FleetingNote.ID,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "literature":
      return {
        type: "literature",
        id: row.id as LiteratureNote.ID,
        title: row.title,
        content: row.content,
        reference: row.reference ?? "",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "permanent":
      return {
        type: "permanent",
        id: row.id as PermanentNote.ID,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
  }
}

// Newest first, then kind and id. Ids are only unique within their own table,
// so the tie-breaker must include the kind as well.
const listOrder = sql`updated_at DESC, type ASC, id ASC`

const listQuery = (db: typeof NoteDatabaseService.Service) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      content: FleetingNoteTable.content,
      reference: sql<string | null>`NULL`.as("reference"),
      createdAt: FleetingNoteTable.createdAt,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          content: LiteratureNoteTable.content,
          reference: LiteratureNoteTable.reference,
          createdAt: LiteratureNoteTable.createdAt,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          content: PermanentNoteTable.content,
          reference: sql<string | null>`NULL`.as("reference"),
          createdAt: PermanentNoteTable.createdAt,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable),
    )
    .orderBy(listOrder)

const listTitlesQuery = (db: typeof NoteDatabaseService.Service) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable),
    )
    .orderBy(listOrder)

// Reads all three note tables directly. It deliberately does not depend on the
// per-kind note services: the database is the only dependency, and each query
// is a single UNION ALL statement.
export const SQLiteNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService

    return NoteService.of({
      list: (_input) => Effect.gen(function* () {
        const rows = yield* listQuery(db)
        return rows.map(toInfo)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      listTitles: (_input) => Effect.gen(function* () {
        const rows = yield* listTitlesQuery(db)
        return rows.map(({ id, type, title }) => ({ id, type, title }))
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
