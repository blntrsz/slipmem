import type { SqliteClient as SqliteClientService } from "@effect/sql-sqlite-bun/SqliteClient"
import type { EffectDrizzleSQLiteConfig } from "drizzle-orm/sqlite-core/effect/utils"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Context, Layer } from "effect"

/** The Drizzle database used by every note service. */
export type NoteDatabase = SQLiteDrizzle.EffectSQLiteBunDatabase

/** Options accepted by Drizzle when the note database is created. */
export type NoteDatabaseConfig = EffectDrizzleSQLiteConfig

/**
 * The configured Drizzle database shared by the note services.
 *
 * Splitting the database out of the individual service layers keeps every
 * service on the same connection and lets callers provide a custom Drizzle
 * configuration (or a test double) without rebuilding each service.
 */
export class NoteDatabaseService extends Context.Service<NoteDatabaseService, NoteDatabase>()(
  "@slipmem/core/NoteDatabase",
) {}

/**
 * Builds the shared database from the current `SqliteClient`.
 *
 * `config` is the same `EffectDrizzleSQLiteConfig` accepted by
 * `SQLiteDrizzle.makeWithDefaults`, so callers can opt into Drizzle options
 * without this package hard-coding them.
 */
export const makeNoteDatabaseLayer = (
  config?: NoteDatabaseConfig,
): Layer.Layer<NoteDatabaseService, never, SqliteClientService> =>
  Layer.effect(NoteDatabaseService, SQLiteDrizzle.makeWithDefaults(config))

/** The default database layer for the current `SqliteClient`. */
export const NoteDatabaseLive = makeNoteDatabaseLayer()
