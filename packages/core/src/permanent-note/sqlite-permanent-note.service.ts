import { eq } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer, Option } from "effect"
import { PermanentNoteNotFound, PermanentNoteService } from "./permanent-note.service"
import { PermanentNoteTable } from "./permanent-note.sql"

export const SQLitePermanentNoteService = Layer.effect(
  PermanentNoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return PermanentNoteService.of({
      create: (input) => Effect.gen(function* () {
        const [row] = yield* db.insert(PermanentNoteTable).values(input).returning()
        return row!
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      get: (input) => Effect.gen(function* () {
        const rows = yield* db.select().from(PermanentNoteTable).where(eq(PermanentNoteTable.id, input.id))
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      list: (_input) => Effect.gen(function* () {
        return yield* db.select().from(PermanentNoteTable)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      update: (input) => Effect.gen(function* () {
        const { id, ...changes } = input
        const rows = yield* db.update(PermanentNoteTable).set(changes).where(eq(PermanentNoteTable.id, id)).returning()
        if (!rows[0]) return yield* new PermanentNoteNotFound({ id })
        return rows[0]
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      delete: (input) => Effect.gen(function* () {
        const rows = yield* db.delete(PermanentNoteTable).where(eq(PermanentNoteTable.id, input.id)).returning({ id: PermanentNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
