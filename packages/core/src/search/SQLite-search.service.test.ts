import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { MemoryScope } from "@slipmem/schemas/memory-scope"
import { Provenance } from "@slipmem/schemas/provenance"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { NoteDatabaseLive } from "../note-database"
import { SQLiteSearchService } from "./SQLite-search.service"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SearchService,
} from "./search.service"

const memoryClient = SqliteClient.layer({ filename: ":memory:" })

const fleetingId = Schema.decodeUnknownSync(FleetingNote.ID)
const literatureId = Schema.decodeUnknownSync(LiteratureNote.ID)
const scope = Schema.decodeUnknownSync(MemoryScope.Scope)

const layer = SQLiteSearchService.pipe(
  Layer.provide(NoteDatabaseLive),
  Layer.provideMerge(memoryClient),
)

const createTables = Effect.gen(function* () {
  const client = yield* SqliteClient.SqliteClient

  yield* client`CREATE TABLE fleeting_note (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    provenance TEXT NOT NULL DEFAULT '{"source":"legacy"}',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  )`
  yield* client`CREATE TABLE permanent_note (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    provenance TEXT NOT NULL DEFAULT '{"source":"legacy"}',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  )`
  yield* client`CREATE TABLE literature_note (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    provenance TEXT NOT NULL DEFAULT '{"source":"legacy"}',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  )`
})

const insertRankedNotes = Effect.gen(function* () {
  const client = yield* SqliteClient.SqliteClient

  yield* client`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('fleeting-search', 'Search basics', 'quick thought', 1, 10)`
  yield* client`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('literature-search', 'Search notes', 'body about sqlite', 'Search Book', 2, 20)`
  yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('permanent-mention', 'Unrelated', 'This body mentions search once', 3, 30)`
})

const defects = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : []

test("ranks term hits by title, reference, then content across all kinds", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      yield* insertRankedNotes

      const search = yield* SearchService
      const result = yield* search.search({ query: "search" })

      expect(result.query).toBe("search")
      expect(result.limit).toBe(DEFAULT_SEARCH_LIMIT)
      expect(result.hasMore).toBe(false)
      expect(result.matches.map((match) => match.note.type)).toEqual([
        "literature",
        "fleeting",
        "permanent",
      ])
      expect(result.matches.map((match) => match.score)).toEqual([8, 5, 1])
      expect(result.matches.map((match) => match.fields)).toEqual([
        ["title", "reference"],
        ["title"],
        ["content"],
      ])

      // Results carry the exact Note.Info shape, including the scope and
      // provenance fields introduced by the scope contract.
      expect(result.matches[0]!.note).toEqual({
        type: "literature",
        id: literatureId("literature-search"),
        title: "Search notes",
        content: "body about sqlite",
        reference: "Search Book",
        scope: MemoryScope.DEFAULT_SCOPE,
        provenance: Provenance.LEGACY,
        createdAt: 2,
        updatedAt: 20,
      })
      expect(result.matches[1]!.note).toEqual({
        type: "fleeting",
        id: fleetingId("fleeting-search"),
        title: "Search basics",
        content: "quick thought",
        scope: MemoryScope.DEFAULT_SCOPE,
        provenance: Provenance.LEGACY,
        createdAt: 1,
        updatedAt: 10,
      })
    }).pipe(Effect.provide(layer)),
  )
})

test("requires every term and scores every matching field", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('both', 'Alpha beta', 'gamma delta', 1, 1)`
      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('split', 'Alpha only', 'beta in body', 1, 2)`
      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('one', 'Alpha only', 'nothing else', 1, 3)`

      const search = yield* SearchService
      const result = yield* search.search({ query: "alpha beta alpha" })

      // Both terms are required, but they may appear in different fields.
      expect(result.matches.map((match) => [String(match.note.id), match.score])).toEqual([
        ["both", 10],
        ["split", 6],
      ])
      expect(result.matches[0]!.fields).toEqual(["title"])
      expect(result.matches[1]!.fields).toEqual(["title", "content"])
    }).pipe(Effect.provide(layer)),
  )
})

test("breaks ranking ties by updatedAt, then kind, then id", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('z', 'tie', '', 1, 10)`
      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('a', 'tie', '', 1, 10)`
      yield* client`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('lit', 'tie', '', 'source', 1, 10)`
      yield* client`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('newer', 'tie', '', 1, 20)`

      const search = yield* SearchService

      expect(
        (yield* search.search({ query: "tie" })).matches.map(
          (match) => `${match.note.type}:${String(match.note.id)}`,
        ),
      ).toEqual(["fleeting:newer", "literature:lit", "permanent:a", "permanent:z"])
    }).pipe(Effect.provide(layer)),
  )
})

test("bounds results, clamps limits, and reports additional matches", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      const client = yield* SqliteClient.SqliteClient

      for (let index = 0; index < 6; index += 1) {
        yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES (${`note-${index}`}, ${`alpha ${index}`}, '', 1, ${index})`
      }

      const search = yield* SearchService

      const two = yield* search.search({ query: "alpha", limit: 2 })
      expect(two.matches.map((match) => String(match.note.id))).toEqual(["note-5", "note-4"])
      expect(two.limit).toBe(2)
      expect(two.hasMore).toBe(true)

      const zero = yield* search.search({ query: "alpha", limit: 0 })
      expect(zero.limit).toBe(1)
      expect(zero.matches).toHaveLength(1)
      expect(zero.hasMore).toBe(true)

      const huge = yield* search.search({ query: "alpha", limit: 10_000 })
      expect(huge.limit).toBe(MAX_SEARCH_LIMIT)
      expect(huge.matches).toHaveLength(6)
      expect(huge.hasMore).toBe(false)

      const fractional = yield* search.search({ query: "alpha", limit: 2.9 })
      expect(fractional.limit).toBe(2)

      const invalid = yield* search.search({ query: "alpha", limit: Number.NaN })
      expect(invalid.limit).toBe(DEFAULT_SEARCH_LIMIT)
    }).pipe(Effect.provide(layer)),
  )
})

test("restricts searches to requested kinds without changing the bound", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      yield* insertRankedNotes

      const search = yield* SearchService

      const fleeting = yield* search.search({ query: "search", kinds: ["fleeting"], limit: 50 })
      expect(fleeting.matches.map((match) => match.note.type)).toEqual(["fleeting"])
      expect(fleeting.limit).toBe(50)
      expect(fleeting.hasMore).toBe(false)

      expect((yield* search.search({ query: "search", kinds: [] })).matches).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})

test("returns no matches for empty or punctuation-only queries without querying", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // No tables are created: an empty query must return before SQL runs.
      const search = yield* SearchService

      expect(yield* search.search({ query: "" })).toEqual({
        query: "",
        limit: DEFAULT_SEARCH_LIMIT,
        hasMore: false,
        matches: [],
      })
      expect(yield* search.search({ query: "  !? -- " })).toEqual({
        query: "  !? -- ",
        limit: DEFAULT_SEARCH_LIMIT,
        hasMore: false,
        matches: [],
      })
    }).pipe(Effect.provide(layer)),
  )
})

test("tokenizes case and punctuation and reports the surviving terms", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES ('lit', 'SQLite-Search', 'text', 'A Book', 1, 1)`

      const search = yield* SearchService
      const result = yield* search.search({ query: "  sqlite-search  " })

      expect(result.matches).toHaveLength(1)
      expect(String(result.matches[0]!.note.id)).toBe("lit")
      expect(result.matches[0]!.score).toBe(10)
    }).pipe(Effect.provide(layer)),
  )
})

test("treats punctuation and SQL operators as literal terms", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES ('for', 'Title-only match for the two-word query.', '', 1, 1)`
      yield* client`INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES ('node', 'Punctuation probe', '100% literal, C++ and node.js.', 1, 2)`

      const search = yield* SearchService

      // Terms are bound parameters and required together, so an injection-like
      // query cannot match whichever note happens to contain only one term.
      expect((yield* search.search({ query: `" OR 1=1 --` })).matches).toEqual([])
      expect(
        (yield* search.search({ query: "node.js" })).matches.map((match) =>
          String(match.note.id),
        ),
      ).toEqual(["node"])
    }).pipe(Effect.provide(layer)),
  )
})

test("filters by scope in SQL before ranking and limiting", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      yield* insertRankedNotes
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO fleeting_note (id, scope, title, content, created_at, updated_at) VALUES ('alpha-fleeting', ${scope("project-alpha")}, 'Search alpha', 'scoped body', 1, 5)`
      yield* client`INSERT INTO literature_note (id, scope, title, content, reference, created_at, updated_at) VALUES ('alpha-literature', ${scope("project-alpha")}, 'Search reference', 'body', 'source', 1, 6)`
      yield* client`INSERT INTO permanent_note (id, scope, title, content, created_at, updated_at) VALUES ('beta-permanent', ${scope("project-beta")}, 'Search beta', 'body', 1, 7)`

      const search = yield* SearchService

      // Omitting scope uses the scope contract's default namespace.
      const byDefault = yield* search.search({ query: "search" })
      expect(byDefault.matches.map((match) => String(match.note.id)).sort()).toEqual([
        "fleeting-search",
        "literature-search",
        "permanent-mention",
      ])

      const alpha = yield* search.search({ query: "search", scope: scope("project-alpha") })
      expect(alpha.matches.map((match) => String(match.note.id)).sort()).toEqual([
        "alpha-fleeting",
        "alpha-literature",
      ])
      expect(alpha.matches.every((match) => match.note.scope === "project-alpha")).toBe(true)

      const beta = yield* search.search({ query: "search", scope: scope("project-beta") })
      expect(beta.matches.map((match) => String(match.note.id))).toEqual(["beta-permanent"])

      // Scope and kind filters compose, and a bounded scope search still only
      // ranks rows from that scope.
      const alphaFleeting = yield* search.search({
        query: "search",
        scope: scope("project-alpha"),
        kinds: ["fleeting"],
        limit: 1,
      })
      expect(alphaFleeting.matches.map((match) => String(match.note.id))).toEqual([
        "alpha-fleeting",
      ])

      const missing = yield* search.search({ query: "search", scope: scope("project-missing") })
      expect(missing.matches).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})

test("dies on Drizzle SQL errors", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // The tables intentionally do not exist.
      const search = yield* SearchService
      const exit = yield* Effect.exit(search.search({ query: "alpha" }))

      expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
    }).pipe(Effect.provide(layer)),
  )
})
