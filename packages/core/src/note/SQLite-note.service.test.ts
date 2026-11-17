import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseLive, NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import { migrateNoteDatabase } from "../test-support/note-database"
import { NoteService } from "./note.service"
import { SQLiteNoteService } from "./SQLite-note.service"

const fleetingId = (value: string) => Schema.decodeUnknownSync(FleetingNote.ID)(value)
const literatureId = (value: string) => Schema.decodeUnknownSync(LiteratureNote.ID)(value)
const permanentId = (value: string) => Schema.decodeUnknownSync(PermanentNote.ID)(value)

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

// Only SqliteClient and the shared NoteDatabase are provided. If the note
// service depended on the per-kind note services, this layer would fail to
// typecheck or construct.
const memoryLayer = () =>
  SQLiteNoteService.pipe(
    Layer.provideMerge(NoteDatabaseLive),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )

const insertNotes = Effect.gen(function* () {
  const db = yield* NoteDatabaseService

  yield* db.insert(FleetingNoteTable).values({
    id: fleetingId("fleeting-1"),
    title: "Fleeting",
    content: "quick thought",
    createdAt: 1,
    updatedAt: 2,
  })
  yield* db.insert(LiteratureNoteTable).values({
    id: literatureId("literature-1"),
    title: "Literature",
    content: "a quote",
    reference: "Book, chapter 2",
    createdAt: 3,
    updatedAt: 4,
  })
  yield* db.insert(PermanentNoteTable).values({
    id: permanentId("permanent-1"),
    title: "Permanent",
    content: "a lasting idea",
    createdAt: 5,
    updatedAt: 6,
  })
})

test("SQLite note service unions the three note tables into the tagged union", async () => {
  const layer = memoryLayer()

  await Effect.runPromise(Effect.gen(function* () {
    yield* migrateNoteDatabase
    yield* insertNotes

    const notes = yield* NoteService

    expect(yield* notes.list({})).toEqual([
      {
        type: "permanent",
        id: permanentId("permanent-1"),
        title: "Permanent",
        content: "a lasting idea",
        createdAt: 5,
        updatedAt: 6,
      },
      {
        type: "literature",
        id: literatureId("literature-1"),
        title: "Literature",
        content: "a quote",
        reference: "Book, chapter 2",
        createdAt: 3,
        updatedAt: 4,
      },
      {
        type: "fleeting",
        id: fleetingId("fleeting-1"),
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
    yield* migrateNoteDatabase
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
    yield* migrateNoteDatabase
    const db = yield* NoteDatabaseService

    yield* db.insert(FleetingNoteTable).values({
      id: fleetingId("fleeting-search"),
      title: "Alpha",
      content: "body text",
      createdAt: 1,
      updatedAt: 40,
    })
    yield* db.insert(LiteratureNoteTable).values({
      id: literatureId("literature-search"),
      title: "Beta",
      content: "alpha in body",
      reference: "Source",
      createdAt: 2,
      updatedAt: 30,
    })
    yield* db.insert(PermanentNoteTable).values({
      id: permanentId("permanent-search"),
      title: "Gamma",
      content: "alpha in body",
      createdAt: 3,
      updatedAt: 20,
    })

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
    yield* migrateNoteDatabase
    const db = yield* NoteDatabaseService

    yield* db.insert(FleetingNoteTable).values({
      id: fleetingId("fleeting-fields"),
      title: "TitleOnly",
      content: "plain body",
      createdAt: 1,
      updatedAt: 1,
    })
    yield* db.insert(LiteratureNoteTable).values({
      id: literatureId("literature-fields"),
      title: "Literature",
      content: "ContentOnly",
      reference: "ReferenceOnly",
      createdAt: 2,
      updatedAt: 2,
    })

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
    yield* migrateNoteDatabase
    const db = yield* NoteDatabaseService

    yield* db.insert(FleetingNoteTable).values([
      {
        id: fleetingId("fleeting-and"),
        title: "Alpha",
        content: "Beta",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: fleetingId("fleeting-other"),
        title: "Alpha",
        content: "Gamma",
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    yield* db.insert(LiteratureNoteTable).values({
      id: literatureId("literature-and"),
      title: "Alpha",
      content: "Body",
      reference: "Beta",
      createdAt: 1,
      updatedAt: 3,
    })

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
    yield* migrateNoteDatabase
    const db = yield* NoteDatabaseService

    yield* db.insert(FleetingNoteTable).values(
      Array.from({ length: 12 }, (_, index) => ({
        id: fleetingId(`fleeting-bound-${index}`),
        title: `Bound ${index}`,
        content: "shared body",
        createdAt: 1,
        updatedAt: index,
      })),
    )
    yield* db.insert(PermanentNoteTable).values({
      id: permanentId("permanent-bound"),
      title: "Bound permanent",
      content: "shared body",
      createdAt: 1,
      updatedAt: 20,
    })

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
    yield* migrateNoteDatabase
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
    yield* migrateNoteDatabase
    const db = yield* NoteDatabaseService

    yield* db.insert(FleetingNoteTable).values([
      {
        id: fleetingId("b"),
        title: "B",
        content: "",
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: fleetingId("a"),
        title: "A",
        content: "",
        createdAt: 1,
        updatedAt: 10,
      },
    ])
    yield* db.insert(LiteratureNoteTable).values({
      id: literatureId("z"),
      title: "Z",
      content: "",
      reference: "Source",
      createdAt: 1,
      updatedAt: 10,
    })
    yield* db.insert(PermanentNoteTable).values({
      id: permanentId("m"),
      title: "M",
      content: "",
      createdAt: 1,
      updatedAt: 10,
    })

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
    yield* migrateNoteDatabase

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
