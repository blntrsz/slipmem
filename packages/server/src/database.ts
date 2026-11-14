import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  makeNoteDatabaseLayer,
  type NoteDatabaseConfig,
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

export interface DatabaseLayerOptions {
  /** Drizzle options for the shared database, such as relations metadata. */
  readonly drizzle?: NoteDatabaseConfig
  /** Override the checked-in Drizzle migrations directory. */
  readonly migrationsFolder?: string
}

/**
 * Builds every note service and the aggregate read-only note service on top of
 * a SQLite database. The database is upgraded by the checked-in Drizzle
 * migrations before any note service is constructed.
 *
 * Pass `":memory:"` for an isolated test database. The same layer is used by
 * the web server and the stdio MCP server so both agree on the schema.
 */
export const makeDatabaseLayer = (
  filename: string,
  options: DatabaseLayerOptions = {},
) => {
  const migrations =
    options.migrationsFolder === undefined
      ? makeMigrationsLayer()
      : makeMigrationsLayer({ migrationsFolder: options.migrationsFolder })

  // `Layer.provide` builds its argument first, so migrations finish before the
  // services (and their database) are constructed. The single `SqliteClient`
  // supplied last is shared by the migration runner and every service.
  return Layer.mergeAll(noteServices, SQLiteNoteService).pipe(
    Layer.provide(makeNoteDatabaseLayer(options.drizzle)),
    Layer.provide(migrations),
    Layer.provide(SqliteClient.layer({ filename })),
  )
}
