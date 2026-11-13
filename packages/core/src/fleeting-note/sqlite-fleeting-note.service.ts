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
      create: (input) => Effect.gen(function* () {
        const [row] = yield* db.insert(FleetingNoteTable).values(input).returning()
        return row!
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      get: (input) => Effect.gen(function* () {
        const rows = yield* db.select().from(FleetingNoteTable).where(eq(FleetingNoteTable.id, input.id))
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      list: (_input) => Effect.gen(function* () {
        return yield* db.select().from(FleetingNoteTable)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      update: (input) => Effect.gen(function* () {
        const { id, ...changes } = input
        const rows = yield* db.update(FleetingNoteTable).set(changes).where(eq(FleetingNoteTable.id, id)).returning()
        if (!rows[0]) return yield* new FleetingNoteNotFound({ id })
        return rows[0]
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      delete: (input) => Effect.gen(function* () {
        const rows = yield* db.delete(FleetingNoteTable).where(eq(FleetingNoteTable.id, input.id)).returning({ id: FleetingNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
