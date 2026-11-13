import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { Effect, Layer, Option, Schema } from "effect"
import { FleetingNoteService } from "./fleeting-note.service"
import { SQLiteFleetingNoteService } from "./sqlite-fleeting-note.service"

test("SQLite fleeting note service persists notes", async () => {
  const sqlite = SqliteClient.layer({ filename: ":memory:" })
  const layer = SQLiteFleetingNoteService.pipe(Layer.provideMerge(sqlite))
  const id = Schema.decodeUnknownSync(FleetingNote.ID)("note-1")
  const note = { id, content: "hello", createdAt: 1, updatedAt: 2 }

  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient
    yield* sql`CREATE TABLE fleeting_note (id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
    const service = yield* FleetingNoteService
    expect(Option.isNone(yield* service.get(id))).toBe(true)
    expect(yield* service.create(note)).toEqual(note)
    expect(Option.getOrThrow(yield* service.get(id))).toEqual(note)
    expect(yield* service.list()).toEqual([note])
    const changed = { ...note, content: "updated", updatedAt: 3 }
    expect(Option.getOrThrow(yield* service.update(changed))).toEqual(changed)
    expect(yield* Effect.flip(service.create(note))).toBeDefined()
    expect(yield* service.delete(id)).toBe(true)
    expect(yield* service.delete(id)).toBe(false)
    expect(Option.isNone(yield* service.update(changed))).toBe(true)
    expect(yield* service.list()).toEqual([])
  }).pipe(Effect.provide(layer)))
})
