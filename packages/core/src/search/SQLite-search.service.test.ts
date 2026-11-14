import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Note } from "@slipmem/schemas/note"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { NoteDatabaseLive } from "../note-database"
import { SQLiteSearchService, UnscopedSQLiteSearchService } from "./SQLite-search.service"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SearchScopeFilter,
  SearchService,
  type SearchScope,
} from "./search.service"

const memoryClient = SqliteClient.layer({ filename: ":memory:" })

const fleetingId = Schema.decodeUnknownSync(FleetingNote.ID)
const literatureId = Schema.decodeUnknownSync(LiteratureNote.ID)

const layerWith = (scopeFilter: Layer.Layer<SearchScopeFilter>) =>
  SQLiteSearchService.pipe(
    Layer.provide(Layer.merge(NoteDatabaseLive, scopeFilter)),
    Layer.provideMerge(memoryClient),
  )

const unscopedLayer = UnscopedSQLiteSearchService.pipe(
  Layer.provide(NoteDatabaseLive),
  Layer.provideMerge(memoryClient),
)

const createTables = Effect.gen(function* () {
  const client = yield* SqliteClient.SqliteClient

  yield* client`CREATE TABLE fleeting_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* client`CREATE TABLE permanent_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* client`CREATE TABLE literature_note (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, reference TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
})

const createScopedTables = Effect.gen(function* () {
  const client = yield* SqliteClient.SqliteClient

  yield* client`CREATE TABLE fleeting_note (id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* client`CREATE TABLE permanent_note (id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
  yield* client`CREATE TABLE literature_note (id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, reference TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)`
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

      // The literature result carries its reference and the other kinds keep
      // the exact Note.Info shape from the unified note schema.
      expect(result.matches[0]!.note).toEqual({
        type: "literature",
        id: literatureId("literature-search"),
        title: "Search notes",
        content: "body about sqlite",
        reference: "Search Book",
        createdAt: 2,
        updatedAt: 20,
      })
      expect(result.matches[1]!.note).toEqual({
        type: "fleeting",
        id: fleetingId("fleeting-search"),
        title: "Search basics",
        content: "quick thought",
        createdAt: 1,
        updatedAt: 10,
      })
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
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
    }).pipe(Effect.provide(unscopedLayer)),
  )
})

test("applies an installed scope filter when a scope is named", async () => {
  const scopeFilter = Layer.succeed(
    SearchScopeFilter,
    SearchScopeFilter.of({
      where: ({ scope, kind }: { readonly scope: SearchScope; readonly kind: Note.Kind }) =>
        kind === "literature" ? undefined : sql`scope_id = ${scope}`,
    }),
  )
  const layer = layerWith(scopeFilter)

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createScopedTables
      const client = yield* SqliteClient.SqliteClient

      yield* client`INSERT INTO fleeting_note (id, scope_id, title, content, created_at, updated_at) VALUES ('f-a', 'a', 'alpha', '', 1, 1)`
      yield* client`INSERT INTO fleeting_note (id, scope_id, title, content, created_at, updated_at) VALUES ('f-b', 'b', 'alpha', '', 1, 2)`
      yield* client`INSERT INTO fleeting_note (id, scope_id, title, content, created_at, updated_at) VALUES ('f-global', 'global', 'alpha', '', 1, 1)`
      yield* client`INSERT INTO permanent_note (id, scope_id, title, content, created_at, updated_at) VALUES ('p-a', 'a', 'alpha', '', 1, 1)`
      yield* client`INSERT INTO permanent_note (id, scope_id, title, content, created_at, updated_at) VALUES ('p-b', 'b', 'alpha', '', 1, 2)`
      yield* client`INSERT INTO permanent_note (id, scope_id, title, content, created_at, updated_at) VALUES ('p-global', 'global', 'alpha', '', 1, 2)`
      yield* client`INSERT INTO literature_note (id, scope_id, title, content, reference, created_at, updated_at) VALUES ('l-a', 'a', 'alpha', '', 'source', 1, 1)`

      const search = yield* SearchService

      const a = yield* search.search({ query: "alpha", scope: "a" })
      expect(a.matches.map((match) => String(match.note.id))).toEqual(["f-a", "p-a"])

      const b = yield* search.search({ query: "alpha", scope: "b" })
      expect(b.matches.map((match) => String(match.note.id))).toEqual(["f-b", "p-b"])

      const missing = yield* search.search({ query: "alpha", scope: "missing" })
      expect(missing.matches).toEqual([])

      // Omitting scope searches every scope and does not consult the filter,
      // so cross-scope memory recall sees every kind and namespace.
      const allScopes = yield* search.search({ query: "alpha" })
      expect(allScopes.matches.map((match) => String(match.note.id))).toEqual([
        "f-b",
        "p-b",
        "p-global",
        "f-a",
        "f-global",
        "l-a",
        "p-a",
      ])
    }).pipe(Effect.provide(layer)),
  )
})

test("the unscoped layer treats every scope as visible", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* createTables
      yield* insertRankedNotes

      const search = yield* SearchService

      expect((yield* search.search({ query: "search" })).matches).toHaveLength(3)
      expect(
        (yield* search.search({ query: "search", scope: "anything" })).matches,
      ).toHaveLength(3)
    }).pipe(Effect.provide(unscopedLayer)),
  )
})

test("dies on Drizzle SQL errors", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // The tables intentionally do not exist.
      const search = yield* SearchService
      const exit = yield* Effect.exit(search.search({ query: "alpha" }))

      expect(defects(exit)).toEqual([expect.any(EffectDrizzleQueryError)])
    }).pipe(Effect.provide(unscopedLayer)),
  )
})
