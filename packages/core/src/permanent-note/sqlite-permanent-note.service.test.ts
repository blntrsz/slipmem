import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { PermanentNoteNotFound, PermanentNoteService } from "./permanent-note.service"
import { SQLitePermanentNoteService } from "./sqlite-permanent-note.service"

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

const memoryLayer = () => {
  const sqlite = SqliteClient.layer({ filename: ":memory:" })
  return SQLitePermanentNoteService.pipe(Layer.provideMerge(sqlite))
}

test("SQLite permanent note service persists notes", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient
    yield* sql`CREATE TABLE permanent_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
    const service = yield* PermanentNoteService

    const beforeCreate = Date.now()
    const created = yield* service.create({ title: "First", content: "hello" })
    const afterCreate = Date.now()

    expect(created.id).toBeString()
    expect(created.id.length).toBeGreaterThan(0)
    expect(created.title).toBe("First")
    expect(created.content).toBe("hello")
    expect(created.createdAt).toBeGreaterThanOrEqual(beforeCreate)
    expect(created.createdAt).toBeLessThanOrEqual(afterCreate)
    expect(created.updatedAt).toBeGreaterThanOrEqual(created.createdAt)

    expect(Option.isNone(yield* service.get({ id: created.id }))).toBe(false)
    expect(Option.getOrThrow(yield* service.get({ id: created.id }))).toEqual(created)
    expect(yield* service.list({})).toEqual([created])

    const second = yield* service.create({ title: "Second", content: "world" })
    expect(second.id).not.toBe(created.id)
    expect(yield* service.list({})).toEqual([created, second])

    yield* Effect.promise(() => Bun.sleep(5))
    const updated = yield* service.update({ id: created.id, title: "Updated", content: "changed" })
    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe("Updated")
    expect(updated.content).toBe("changed")
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(Option.getOrThrow(yield* service.get({ id: created.id }))).toEqual(updated)

    expect(yield* service.delete({ id: created.id })).toBe(true)
    expect(yield* service.delete({ id: created.id })).toBe(false)
    const missing = yield* Effect.flip(service.update({ id: created.id, title: "Missing", content: "missing" }))
    expect(missing).toBeInstanceOf(PermanentNoteNotFound)
    expect(missing.id).toBe(created.id)
    expect(yield* service.list({})).toEqual([second])
  }).pipe(Effect.provide(layer)))
})

test("SQLite permanent note service dies on Drizzle SQL errors", async () => {
  const layer = memoryLayer()
  const id = Schema.decodeUnknownSync(PermanentNote.ID)("note-1")
  const input = { title: "A title", content: "hello" }

  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* PermanentNoteService
    const exits = [
      yield* Effect.exit(service.create(input)),
      yield* Effect.exit(service.get({ id })),
      yield* Effect.exit(service.list({})),
      yield* Effect.exit(service.update({ id, ...input })),
      yield* Effect.exit(service.delete({ id })),
    ]

    for (const exit of exits) {
      expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
    }
  }).pipe(Effect.provide(layer)))
})
