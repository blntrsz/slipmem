import { eq } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer, Option } from "effect"
import { LiteratureNoteNotFound, LiteratureNoteService } from "./literature-note.service"
import { LiteratureNoteTable } from "./literature-note.sql"

export const SQLiteLiteratureNoteService = Layer.effect(
  LiteratureNoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return LiteratureNoteService.of({
      create: (input) => Effect.gen(function* () {
        const [row] = yield* db.insert(LiteratureNoteTable).values(input).returning()
        return row!
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      get: (input) => Effect.gen(function* () {
        const rows = yield* db.select().from(LiteratureNoteTable).where(eq(LiteratureNoteTable.id, input.id))
        return Option.fromNullishOr(rows[0])
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      list: (_input) => Effect.gen(function* () {
        return yield* db.select().from(LiteratureNoteTable)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      update: (input) => Effect.gen(function* () {
        const { id, ...changes } = input
        const rows = yield* db.update(LiteratureNoteTable).set(changes).where(eq(LiteratureNoteTable.id, id)).returning()
        if (!rows[0]) return yield* new LiteratureNoteNotFound({ id })
        return rows[0]
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      delete: (input) => Effect.gen(function* () {
        const rows = yield* db.delete(LiteratureNoteTable).where(eq(LiteratureNoteTable.id, input.id)).returning({ id: LiteratureNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
