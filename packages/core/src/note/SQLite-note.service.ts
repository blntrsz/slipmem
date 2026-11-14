import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { sql } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
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

const listQuery = (db: SQLiteDrizzle.EffectSQLiteBunDatabase) =>
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

const listTitlesQuery = (db: SQLiteDrizzle.EffectSQLiteBunDatabase) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
    })
    .from(FleetingNoteTable)
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
        })
        .from(LiteratureNoteTable),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
        })
        .from(PermanentNoteTable),
    )

// Reads all three note tables directly. It deliberately does not depend on the
// per-kind note services: the database is the only dependency, and each query
// is a single UNION ALL statement.
export const SQLiteNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return NoteService.of({
      list: (_input) => Effect.gen(function* () {
        const rows = yield* listQuery(db)
        return rows.map(toInfo)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      listTitles: (_input) => Effect.gen(function* () {
        return yield* listTitlesQuery(db)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
