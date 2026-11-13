import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { LiteratureNoteNotFound, LiteratureNoteService } from "./literature-note.service"
import { SQLiteLiteratureNoteService } from "./sqlite-literature-note.service"

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

const memoryLayer = () => {
  const sqlite = SqliteClient.layer({ filename: ":memory:" })
  return SQLiteLiteratureNoteService.pipe(Layer.provideMerge(sqlite))
}

test("SQLite literature note service persists notes", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient
    yield* sql`CREATE TABLE literature_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, reference TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
    const service = yield* LiteratureNoteService

    const beforeCreate = Date.now()
    const created = yield* service.create({ title: "First", content: "hello", reference: "Book, chapter 1" })
    const afterCreate = Date.now()

    expect(created.id).toBeString()
    expect(created.id.length).toBeGreaterThan(0)
    expect(created.title).toBe("First")
    expect(created.content).toBe("hello")
    expect(created.reference).toBe("Book, chapter 1")
    expect(created.createdAt).toBeGreaterThanOrEqual(beforeCreate)
    expect(created.createdAt).toBeLessThanOrEqual(afterCreate)
    expect(created.updatedAt).toBeGreaterThanOrEqual(created.createdAt)

    expect(Option.isNone(yield* service.get({ id: created.id }))).toBe(false)
    expect(Option.getOrThrow(yield* service.get({ id: created.id }))).toEqual(created)
    expect(yield* service.list({})).toEqual([created])

    const second = yield* service.create({ title: "Second", content: "world", reference: "Article, section 2" })
    expect(second.id).not.toBe(created.id)
    expect(yield* service.list({})).toEqual([created, second])

    yield* Effect.promise(() => Bun.sleep(5))
    const updated = yield* service.update({ id: created.id, title: "Updated", content: "changed", reference: "Book, chapter 2" })
    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe("Updated")
    expect(updated.content).toBe("changed")
    expect(updated.reference).toBe("Book, chapter 2")
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(Option.getOrThrow(yield* service.get({ id: created.id }))).toEqual(updated)

    expect(yield* service.delete({ id: created.id })).toBe(true)
    expect(yield* service.delete({ id: created.id })).toBe(false)
    const missing = yield* Effect.flip(service.update({ id: created.id, title: "Missing", content: "missing", reference: "Missing" }))
    expect(missing).toBeInstanceOf(LiteratureNoteNotFound)
    expect(missing.id).toBe(created.id)
    expect(yield* service.list({})).toEqual([second])
  }).pipe(Effect.provide(layer)))
})

test("SQLite literature note service dies on Drizzle SQL errors", async () => {
  const layer = memoryLayer()
  const id = Schema.decodeUnknownSync(LiteratureNote.ID)("note-1")
  const input = { title: "A title", content: "hello", reference: "Book, chapter 1" }

  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* LiteratureNoteService
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
