import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  CombinedNoteService,
  SQLiteFleetingNoteService,
  SQLiteLiteratureNoteService,
  SQLitePermanentNoteService,
} from "@slipmem/core"
import { Effect, Layer } from "effect"

// The SQLite tables mirror the Drizzle table definitions in @slipmem/core.
// Keeping the bootstrap here means the web app can run against a fresh
// database file without a separate migration step.
const createTables = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      )
    `

    yield* sql`
      CREATE TABLE IF NOT EXISTS permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      )
    `

    yield* sql`
      CREATE TABLE IF NOT EXISTS literature_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        reference TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      )
    `
  }),
)

const noteServices = Layer.mergeAll(
  SQLiteFleetingNoteService,
  SQLiteLiteratureNoteService,
  SQLitePermanentNoteService,
)

/**
 * Builds every note service and the combined read-only note service on top of
 * a SQLite database, creating the tables if they do not exist yet. Pass
 * `":memory:"` for an isolated test database.
 */
export const makeDatabaseLayer = (filename: string) =>
  Layer.mergeAll(
    createTables,
    noteServices,
    CombinedNoteService.pipe(Layer.provide(noteServices)),
  ).pipe(Layer.provide(SqliteClient.layer({ filename })))
