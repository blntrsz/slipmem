import { eq } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer, Option } from "effect"
import { FleetingNoteNotFound, FleetingNoteService } from "./fleeting-note.service"
import { FleetingNoteTable } from "./fleeting-note.sql"

export const SQLiteFleetingNoteService = Layer.effect(
  FleetingNoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return FleetingNoteService.of({
      create: (note) => Effect.gen(function* () {
        const [row] = yield* db.insert(FleetingNoteTable).values(note).returning()
        return row!
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      get: (id) => Effect.gen(function* () {
        const rows = yield* db.select().from(FleetingNoteTable).where(eq(FleetingNoteTable.id, id))
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      list: () => Effect.gen(function* () {
        return yield* db.select().from(FleetingNoteTable)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      update: (note) => Effect.gen(function* () {
        const rows = yield* db.update(FleetingNoteTable).set(note).where(eq(FleetingNoteTable.id, note.id)).returning()
        if (!rows[0]) return yield* new FleetingNoteNotFound({ id: note.id })
        return rows[0]
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      delete: (id) => Effect.gen(function* () {
        const rows = yield* db.delete(FleetingNoteTable).where(eq(FleetingNoteTable.id, id)).returning({ id: FleetingNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
