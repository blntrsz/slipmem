import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer } from "effect"
import { FleetingNoteService } from "../fleeting-note/fleeting-note.service"
import { SQLiteFleetingNoteService } from "../fleeting-note/sqlite-fleeting-note.service"
import { LiteratureNoteService } from "../literature-note/literature-note.service"
import { SQLiteLiteratureNoteService } from "../literature-note/sqlite-literature-note.service"
import { PermanentNoteService } from "../permanent-note/permanent-note.service"
import { SQLitePermanentNoteService } from "../permanent-note/sqlite-permanent-note.service"
import { CombinedNoteService } from "./combined-note.service"
import { NoteService } from "./note.service"

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

const memoryLayer = () => {
  const sqlite = SqliteClient.layer({ filename: ":memory:" })
  const noteServices = Layer.mergeAll(
    SQLiteFleetingNoteService,
    SQLiteLiteratureNoteService,
    SQLitePermanentNoteService,
  ).pipe(Layer.provideMerge(sqlite))

  return CombinedNoteService.pipe(Layer.provideMerge(noteServices))
}

const createTables = Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient

  yield* sql`CREATE TABLE fleeting_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* sql`CREATE TABLE permanent_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* sql`CREATE TABLE literature_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, reference TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
})

test("combined note service lists every note kind as a tagged union", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables

    const fleeting = yield* FleetingNoteService
    const literature = yield* LiteratureNoteService
    const permanent = yield* PermanentNoteService
    const notes = yield* NoteService

    expect(yield* notes.list({})).toEqual([])

    const createdFleeting = yield* fleeting.create({ title: "Fleeting", content: "quick thought" })
    const createdLiterature = yield* literature.create({
      title: "Literature",
      content: "a quote",
      reference: "Book, chapter 2",
    })
    const createdPermanent = yield* permanent.create({ title: "Permanent", content: "a lasting idea" })

    expect(yield* notes.list({})).toEqual([
      { type: "fleeting", ...createdFleeting },
      { type: "literature", ...createdLiterature },
      { type: "permanent", ...createdPermanent },
    ])
  }).pipe(Effect.provide(layer)))
})

test("combined note service keeps each kind's constraint and list order", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables

    const fleeting = yield* FleetingNoteService
    const notes = yield* NoteService

    const first = yield* fleeting.create({ title: "First", content: "one" })
    const second = yield* fleeting.create({ title: "Second", content: "two" })

    expect(yield* notes.list({})).toEqual([
      { type: "fleeting", ...first },
      { type: "fleeting", ...second },
    ])
  }).pipe(Effect.provide(layer)))
})

test("combined note service dies on Drizzle SQL errors", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    const notes = yield* NoteService

    const exit = yield* Effect.exit(notes.list({}))
    expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
  }).pipe(Effect.provide(layer)))
})
