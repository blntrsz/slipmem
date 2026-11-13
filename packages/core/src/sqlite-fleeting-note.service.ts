import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { eq } from "drizzle-orm"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Effect, Layer, Option, Schema } from "effect"
import { FleetingNoteError, FleetingNoteService } from "./fleeting-note.service"
import { FleetingNoteTable } from "./fleeting-note.sql"

const decode = Schema.decodeUnknownEffect(FleetingNote.Info)
const toNote = (row: typeof FleetingNoteTable.$inferSelect) =>
  decode({ id: row.id, content: row.content, time: { created: row.created, updated: row.updated } })
const toRow = (note: FleetingNote.Info) => ({
  id: note.id,
  content: note.content,
  created: note.time.created,
  updated: note.time.updated,
})
const mapError = (cause: unknown) => new FleetingNoteError({ cause })

export const SQLiteFleetingNoteService = Layer.effect(
  FleetingNoteService,
  Effect.gen(function* () {
    const db = yield* SQLiteDrizzle.makeWithDefaults()

    return FleetingNoteService.of({
      create: (note) => Effect.gen(function* () {
        const valid = yield* decode(note)
        const [row] = yield* db.insert(FleetingNoteTable).values(toRow(valid)).returning()
        return yield* toNote(row!)
      }).pipe(Effect.mapError(mapError)),
      get: (id) => Effect.gen(function* () {
        const rows = yield* db.select().from(FleetingNoteTable).where(eq(FleetingNoteTable.id, id))
        return rows[0] ? Option.some(yield* toNote(rows[0])) : Option.none()
      }).pipe(Effect.mapError(mapError)),
      list: () => Effect.gen(function* () {
        const rows = yield* db.select().from(FleetingNoteTable)
        return yield* Effect.forEach(rows, toNote)
      }).pipe(Effect.mapError(mapError)),
      update: (note) => Effect.gen(function* () {
        const valid = yield* decode(note)
        const rows = yield* db.update(FleetingNoteTable).set(toRow(valid)).where(eq(FleetingNoteTable.id, valid.id)).returning()
        return rows[0] ? Option.some(yield* toNote(rows[0])) : Option.none()
      }).pipe(Effect.mapError(mapError)),
      delete: (id) => Effect.gen(function* () {
        const rows = yield* db.delete(FleetingNoteTable).where(eq(FleetingNoteTable.id, id)).returning({ id: FleetingNoteTable.id })
        return rows.length > 0
      }).pipe(Effect.mapError(mapError)),
    })
  }),
)
