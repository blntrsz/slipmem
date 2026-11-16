import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { NoteDatabaseLive } from "../note-database"
import { NoteService } from "./note.service"
import { SQLiteNoteService } from "./SQLite-note.service"

const fleetingId = Schema.decodeUnknownSync(FleetingNote.ID)("fleeting-1")
const literatureId = Schema.decodeUnknownSync(LiteratureNote.ID)("literature-1")
const permanentId = Schema.decodeUnknownSync(PermanentNote.ID)("permanent-1")

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

// Only SqliteClient and the shared NoteDatabase are provided. If the note
// service depended on the per-kind note services, this layer would fail to
// typecheck or construct.
const memoryLayer = () =>
  SQLiteNoteService.pipe(
    Layer.provide(NoteDatabaseLive),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )

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
        type: "permanent",
        id: permanentId,
        title: "Permanent",
        content: "a lasting idea",
        createdAt: 5,
        updatedAt: 6,
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
        type: "fleeting",
        id: fleetingId,
        title: "Fleeting",
        content: "quick thought",
        createdAt: 1,
        updatedAt: 2,
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
      { id: "permanent-1", type: "permanent", title: "Permanent" },
      { id: "literature-1", type: "literature", title: "Literature" },
      { id: "fleeting-1", type: "fleeting", title: "Fleeting" },
    ])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service searches all note kinds and ranks title matches first", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    const sql = yield* SqliteClient.SqliteClient

    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-search', 'Alpha', 'body text', 1, 40)`
    yield* sql`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('literature-search', 'Beta', 'alpha in body', 'Source', 2, 30)`
    yield* sql`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('permanent-search', 'Gamma', 'alpha in body', 3, 20)`

    const notes = yield* NoteService

    expect((yield* notes.search({ query: "alpha" })).map((note) => `${note.type}:${note.id}`)).toEqual([
      "fleeting:fleeting-search",
      "literature:literature-search",
      "permanent:permanent-search",
    ])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service restricts search to title, content, or reference", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    const sql = yield* SqliteClient.SqliteClient

    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-fields', 'TitleOnly', 'plain body', 1, 1)`
    yield* sql`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('literature-fields', 'Literature', 'ContentOnly', 'ReferenceOnly', 2, 2)`

    const notes = yield* NoteService

    expect(
      (yield* notes.search({ query: "titleonly", fields: ["title"] })).map((note) => note.title),
    ).toEqual(["TitleOnly"])
    expect(yield* notes.search({ query: "titleonly", fields: ["content"] })).toEqual([])

    expect(
      (yield* notes.search({ query: "contentonly", fields: ["content"] })).map((note) => note.title),
    ).toEqual(["Literature"])
    expect(yield* notes.search({ query: "contentonly", fields: ["title"] })).toEqual([])

    expect(
      (yield* notes.search({ query: "referenceonly" })).map((note) => note.title),
    ).toEqual(["Literature"])
    expect(
      yield* notes.search({ query: "referenceonly", fields: ["title", "content"] }),
    ).toEqual([])

    expect(yield* notes.search({ query: "titleonly", fields: [] })).toEqual([])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service requires every query term to match", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    const sql = yield* SqliteClient.SqliteClient

    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-and', 'Alpha', 'Beta', 1, 1)`
    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-other', 'Alpha', 'Gamma', 1, 2)`
    yield* sql`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('literature-and', 'Alpha', 'Body', 'Beta', 1, 3)`

    const notes = yield* NoteService

    expect(
      (yield* notes.search({ query: "alpha beta" })).map((note) => `${note.id}`),
    ).toEqual(["literature-and", "fleeting-and"])
    expect(
      (yield* notes.search({ query: "alpha alpha" })).map((note) => `${note.id}`),
    ).toEqual(["literature-and", "fleeting-other", "fleeting-and"])
    expect(yield* notes.search({ query: "alpha delta" })).toEqual([])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service filters search by kind and bounds results", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    const sql = yield* SqliteClient.SqliteClient

    for (let index = 0; index < 12; index += 1) {
      yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (${`fleeting-bound-${index}`}, ${`Bound ${index}`}, 'shared body', 1, ${index})`
    }
    yield* sql`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('permanent-bound', 'Bound permanent', 'shared body', 1, 20)`

    const notes = yield* NoteService

    const defaults = yield* notes.search({ query: "bound" })
    expect(defaults).toHaveLength(10)
    expect(defaults[0] === undefined ? undefined : `${defaults[0].id}`).toBe("permanent-bound")

    expect(yield* notes.search({ query: "bound", limit: 0 })).toHaveLength(1)
    expect(yield* notes.search({ query: "bound", limit: 50 })).toHaveLength(13)

    expect(
      (yield* notes.search({ query: "bound", kinds: ["permanent"] })).map((note) => `${note.id}`),
    ).toEqual(["permanent-bound"])
    expect(yield* notes.search({ query: "bound", kinds: [] })).toEqual([])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service ignores empty and punctuation-only search queries", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    yield* insertNotes

    const notes = yield* NoteService

    expect(yield* notes.search({ query: "" })).toEqual([])
    expect(yield* notes.search({ query: "   " })).toEqual([])
    expect(yield* notes.search({ query: "?!,.;" })).toEqual([])
    expect(
      (yield* notes.search({ query: "  QUOTE?! " })).map((note) => `${note.id}`),
    ).toEqual(["literature-1"])
  }).pipe(Effect.provide(layer)))
})

test("SQLite note service orders ties by kind and id", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* createTables
    const sql = yield* SqliteClient.SqliteClient

    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('b', 'B', '', 1, 10)`
    yield* sql`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('a', 'A', '', 1, 10)`
    yield* sql`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('z', 'Z', '', 'Source', 1, 10)`
    yield* sql`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('m', 'M', '', 1, 10)`

    const notes = yield* NoteService

    expect((yield* notes.list({})).map((note) => `${note.type}:${note.id}`)).toEqual([
      "fleeting:a",
      "fleeting:b",
      "literature:z",
      "permanent:m",
    ])
    expect((yield* notes.listTitles({})).map((note) => `${note.type}:${note.id}`)).toEqual([
      "fleeting:a",
      "fleeting:b",
      "literature:z",
      "permanent:m",
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
      yield* Effect.exit(notes.search({ query: "anything" })),
    ]

    for (const exit of exits) {
      expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
    }
  }).pipe(Effect.provide(layer)))
})
