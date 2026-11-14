import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  SQLiteFleetingNoteService,
  SQLiteLiteratureNoteService,
  SQLiteNoteService,
  SQLitePermanentNoteService,
} from "@slipmem/core"
import { Layer } from "effect"
import { makeMigrationsLayer } from "./migrations"

const noteServices = Layer.mergeAll(
  SQLiteFleetingNoteService,
  SQLiteLiteratureNoteService,
  SQLitePermanentNoteService,
)

/**
 * Builds every note service and the aggregate read-only note service on top of
 * a SQLite database. The database is upgraded by the checked-in Drizzle
 * migrations, which preserve rows in databases created by older versions.
 *
 * Pass `":memory:"` for an isolated test database. The same layer is used by
 * the web server and the stdio MCP server so both agree on the schema.
 */
export const makeDatabaseLayer = (filename: string) =>
  Layer.mergeAll(
    makeMigrationsLayer(),
    noteServices,
    SQLiteNoteService,
  ).pipe(Layer.provide(SqliteClient.layer({ filename })))
