import { eq } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer, Option } from "effect"
import { FleetingNoteError, FleetingNoteService } from "./fleeting-note.service"
import { FleetingNoteTable } from "./fleeting-note.sql"

const mapError = (cause: unknown) => new FleetingNoteError({ cause })

export const SQLiteFleetingNoteService = Layer.effect(
  FleetingNoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return FleetingNoteService.of({
      create: (note) => Effect.gen(function* () {
        const [row] = yield* db.insert(FleetingNoteTable).values(note).returning()
        return row!
      }).pipe(Effect.mapError(mapError)),
      get: (id) => Effect.gen(function* () {
        const rows = yield* db.select().from(FleetingNoteTable).where(eq(FleetingNoteTable.id, id))
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.mapError(mapError)),
      list: () => Effect.gen(function* () {
        return yield* db.select().from(FleetingNoteTable)
      }).pipe(Effect.mapError(mapError)),
      update: (note) => Effect.gen(function* () {
        const rows = yield* db.update(FleetingNoteTable).set(note).where(eq(FleetingNoteTable.id, note.id)).returning()
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.mapError(mapError)),
      delete: (id) => Effect.gen(function* () {
        const rows = yield* db.delete(FleetingNoteTable).where(eq(FleetingNoteTable.id, id)).returning({ id: FleetingNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.mapError(mapError)),
    })
  }),
)
