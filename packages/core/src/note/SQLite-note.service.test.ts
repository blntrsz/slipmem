import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { NoteService } from "./note.service"
import { SQLiteNoteService } from "./SQLite-note.service"

const fleetingId = Schema.decodeUnknownSync(FleetingNote.ID)("fleeting-1")
const literatureId = Schema.decodeUnknownSync(LiteratureNote.ID)("literature-1")
const permanentId = Schema.decodeUnknownSync(PermanentNote.ID)("permanent-1")

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

// Only SqliteClient is provided. If the note service depended on the per-kind
// note services, this layer would fail to typecheck or construct.
const memoryLayer = () =>
  SQLiteNoteService.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const createTables = Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient

  yield* sql`CREATE TABLE fleeting_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* sql`CREATE TABLE permanent_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* sql`CREATE TABLE literature_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, reference TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
})

const insertNotes = Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient

  yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-1', 'Fleeting', 'quick thought', 1, 2)`
  yield* sql`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('literature-1', 'Literature', 'a quote', 'Book, chapter 2', 3, 4)`
  yield* sql`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('permanent-1', 'Permanent', 'a lasting idea', 5, 6)`
})

test("SQLite note service unions the three note tables into the tagged union", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    yield* insertNotes

    const notes = yield* NoteService

    expect(yield* notes.list({})).toEqual([
      {
        type: "fleeting",
        id: fleetingId,
        title: "Fleeting",
        content: "quick thought",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        type: "literature",
        id: literatureId,
        title: "Literature",
        content: "a quote",
        reference: "Book, chapter 2",
        createdAt: 3,
        updatedAt: 4,
      },
      {
        type: "permanent",
        id: permanentId,
        title: "Permanent",
        content: "a lasting idea",
        createdAt: 5,
        updatedAt: 6,
      },
    ])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service lists titles across all note kinds", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    yield* insertNotes

    const notes = yield* NoteService

    expect(yield* notes.listTitles({})).toEqual([
      { id: "fleeting-1", type: "fleeting", title: "Fleeting" },
      { id: "literature-1", type: "literature", title: "Literature" },
      { id: "permanent-1", type: "permanent", title: "Permanent" },
    ])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service returns empty lists for empty tables", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables

    const notes = yield* NoteService

    expect(yield* notes.list({})).toEqual([])
    expect(yield* notes.listTitles({})).toEqual([])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service dies on Drizzle SQL errors", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    const notes = yield* NoteService

    const exits = [
      yield* Effect.exit(notes.list({})),
      yield* Effect.exit(notes.listTitles({})),
    ]

    for (const exit of exits) {
      expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
    }
  }).pipe(Effect.provide(layer)))
})
