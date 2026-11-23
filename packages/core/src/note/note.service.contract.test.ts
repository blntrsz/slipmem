import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Note } from "@slipmem/schemas/note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Effect, Layer, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import {
  MarkdownNoteRepositoryLive,
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import { MarkdownSearchIndexFromRepository } from "../markdown/search-index.js"
import { NoteDatabaseLive, NoteDatabaseService } from "../note-database"
import { migrateNoteDatabase } from "../test-support/note-database"
import { MarkdownNoteService } from "./markdown-note.service"
import { NoteService } from "./note.service"
import { SQLiteNoteService } from "./SQLite-note.service"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")
const NOTE_COUNT = 12
const CONTENT = "Shared body about bounded notes."

interface Seed {
  readonly id: string
  readonly type: "fleeting" | "literature" | "permanent"
  readonly title: string
  readonly content: string
  readonly reference?: string
  /** Markdown-only metadata; the SQLite note tables have no tag column. */
  readonly tags?: ReadonlyArray<string>
  readonly createdAt: number
  readonly updatedAt: number
}

const at = (index: number): { createdAt: number; updatedAt: number } => ({
  createdAt: FIXED_NOW + index * 1_000,
  updatedAt: FIXED_NOW + index * 1_000,
})

const asciiSeeds = (): ReadonlyArray<Seed> => [
  ...Array.from({ length: NOTE_COUNT }, (_, index): Seed => {
    const label = String(index).padStart(2, "0")
    return {
      id: `parity-note-${label}`,
      type: "fleeting",
      title: `Parity note ${label}`,
      content: CONTENT,
      ...at(index),
    }
  }),
  {
    id: "reference-note",
    type: "literature",
    title: "Reference note",
    content: CONTENT,
    reference: "Reference source",
    ...at(NOTE_COUNT),
  },
]

// "retrieval" appears only in Markdown frontmatter. SQLite has nowhere to store
// it, which is exactly the capability split the service contract documents.
const tagSeeds = (): ReadonlyArray<Seed> => [
  {
    id: "tagged-note",
    type: "permanent",
    title: "Tagged note",
    content: "Body without the tag word.",
    tags: ["retrieval"],
    ...at(0),
  },
]

const unicodeSeeds = (): ReadonlyArray<Seed> => [
  {
    id: "note-one",
    type: "fleeting",
    title: "Note one",
    content: "Le Café est ouvert.",
    ...at(0),
  },
  {
    id: "note-two",
    type: "fleeting",
    title: "Note two",
    content: "Привет мир.",
    ...at(1),
  },
]

interface Reads {
  readonly list: ReadonlyArray<Note.Info>
  readonly listZero: ReadonlyArray<Note.Info>
  readonly listFive: ReadonlyArray<Note.Info>
  readonly titles: ReadonlyArray<Note.TitleInfo>
  readonly titlesFive: ReadonlyArray<Note.TitleInfo>
  readonly search: ReadonlyArray<Note.Info>
  readonly searchContent: ReadonlyArray<Note.Info>
  readonly searchBody: ReadonlyArray<Note.Info>
  readonly searchReference: ReadonlyArray<Note.Info>
  readonly searchKindMiss: ReadonlyArray<Note.Info>
  readonly searchEmptyFields: ReadonlyArray<Note.Info>
  readonly searchLimitZero: ReadonlyArray<Note.Info>
  readonly searchTagField: ReadonlyArray<Note.Info>
  readonly searchTagDefault: ReadonlyArray<Note.Info>
  readonly searchUnicodeExact: ReadonlyArray<Note.Info>
  readonly searchUnicodeUpper: ReadonlyArray<Note.Info>
  readonly searchUnicodeStripped: ReadonlyArray<Note.Info>
  readonly searchUnicodeCyrillic: ReadonlyArray<Note.Info>
}

const readNotes = Effect.gen(function* () {
  const notes = yield* NoteService
  const all = { limit: Note.MAX_LIST_LIMIT }
  return {
    list: yield* notes.list({}),
    listZero: yield* notes.list({ limit: 0 }),
    listFive: yield* notes.list({ limit: 5 }),
    titles: yield* notes.listTitles({}),
    titlesFive: yield* notes.listTitles({ limit: 5 }),
    search: yield* notes.search({ query: "parity", ...all }),
    searchContent: yield* notes.search({
      query: "shared",
      fields: ["content"],
      ...all,
    }),
    searchBody: yield* notes.search({ query: "body", ...all }),
    searchReference: yield* notes.search({
      query: "reference",
      fields: ["reference"],
    }),
    searchKindMiss: yield* notes.search({
      query: "parity",
      kinds: ["permanent"],
    }),
    searchEmptyFields: yield* notes.search({ query: "parity", fields: [] }),
    searchLimitZero: yield* notes.search({ query: "parity", limit: 0 }),
    searchTagField: yield* notes.search({
      query: "retrieval",
      fields: ["tags"],
      ...all,
    }),
    searchTagDefault: yield* notes.search({ query: "retrieval", ...all }),
    searchUnicodeExact: yield* notes.search({ query: "café", ...all }),
    searchUnicodeUpper: yield* notes.search({ query: "CAFÉ", ...all }),
    searchUnicodeStripped: yield* notes.search({ query: "cafe", ...all }),
    searchUnicodeCyrillic: yield* notes.search({ query: "привет", ...all }),
  } satisfies Reads
})

const sqliteReads = (seedValues: ReadonlyArray<Seed>): Promise<Reads> => {
  const layer = SQLiteNoteService.pipe(
    Layer.provideMerge(NoteDatabaseLive),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )

  return Effect.runPromise(
    Effect.gen(function* () {
      yield* migrateNoteDatabase
      const db = yield* NoteDatabaseService

      const fleetingRows = seedValues
        .filter((seed) => seed.type === "fleeting")
        .map((seed) => ({
          id: Schema.decodeUnknownSync(FleetingNote.ID)(seed.id),
          title: seed.title,
          content: seed.content,
          createdAt: seed.createdAt,
          updatedAt: seed.updatedAt,
        }))
      const literatureRows = seedValues
        .filter((seed) => seed.type === "literature")
        .map((seed) => ({
          id: Schema.decodeUnknownSync(LiteratureNote.ID)(seed.id),
          title: seed.title,
          content: seed.content,
          reference: seed.reference ?? "",
          createdAt: seed.createdAt,
          updatedAt: seed.updatedAt,
        }))
      const permanentRows = seedValues
        .filter((seed) => seed.type === "permanent")
        .map((seed) => ({
          id: Schema.decodeUnknownSync(PermanentNote.ID)(seed.id),
          title: seed.title,
          content: seed.content,
          createdAt: seed.createdAt,
          updatedAt: seed.updatedAt,
        }))

      if (fleetingRows.length > 0) {
        yield* db.insert(FleetingNoteTable).values(fleetingRows)
      }
      if (literatureRows.length > 0) {
        yield* db.insert(LiteratureNoteTable).values(literatureRows)
      }
      if (permanentRows.length > 0) {
        yield* db.insert(PermanentNoteTable).values(permanentRows)
      }

      return yield* readNotes
    }).pipe(Effect.provide(layer)),
  )
}

const markdownReads = async (
  seedValues: ReadonlyArray<Seed>,
  options: { readonly forceLinearFallback?: boolean } = {},
): Promise<{ reads: Reads; cleanup: () => void }> => {
  const base = mkdtempSync("/tmp/opencode/slipmem-note-parity-")
  const root = join(base, ".slipmem")
  const backupDir = join(base, "backups")
  const cacheDir = join(base, "cache")
  mkdirSync(root, { recursive: true })

  const clock = { value: FIXED_NOW }
  const repository: MarkdownNoteRepositoryShape = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir,
      now: () => clock.value,
    }),
  )

  for (const seed of seedValues) {
    clock.value = seed.createdAt
    await Effect.runPromise(
      repository.create({
        type: seed.type,
        title: seed.title,
        content: seed.content,
        ...(seed.reference === undefined ? {} : { reference: seed.reference }),
        ...(seed.tags === undefined ? {} : { tags: seed.tags }),
      }),
    )
  }

  const services = Layer.provideMerge(
    MarkdownSearchIndexFromRepository({
      cacheDir,
      ...(options.forceLinearFallback === undefined
        ? {}
        : { forceLinearFallback: options.forceLinearFallback }),
    }),
    MarkdownNoteRepositoryLive({ root, backupDir, now: () => clock.value }),
  )
  const layer = MarkdownNoteService.pipe(Layer.provide(services))
  const reads = await Effect.runPromise(
    readNotes.pipe(Effect.provide(layer)),
  )

  return { reads, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const ids = (notes: ReadonlyArray<{ readonly id: unknown }>): Array<string> =>
  notes.map((note) => String(note.id))

const sortedIds = (notes: ReadonlyArray<{ readonly id: unknown }>): Array<string> =>
  ids(notes).sort()

const validate = (schema: Schema.ConstraintDecoder<unknown>, values: ReadonlyArray<unknown>): void => {
  for (const value of values) {
    expect(Schema.decodeUnknownOption(schema)(value)._tag).toBe("Some")
  }
}

const assertEquivalent = (
  sqlite: Reads,
  markdown: Reads,
): void => {
  expect(ids(markdown.list)).toEqual(ids(sqlite.list))
  expect(ids(markdown.listZero)).toEqual(ids(sqlite.listZero))
  expect(ids(markdown.listFive)).toEqual(ids(sqlite.listFive))
  expect(ids(markdown.titles)).toEqual(ids(sqlite.titles))
  expect(ids(markdown.titlesFive)).toEqual(ids(sqlite.titlesFive))
  // List order is part of the contract. Search keeps the same bound, filter,
  // and newest-first tie rule, but relevance scores belong to each engine, so
  // a full-result comparison is by membership; the SQLite ranking rules have
  // their own tests.
  expect(sortedIds(markdown.search)).toEqual(sortedIds(sqlite.search))
  expect(sortedIds(markdown.searchContent)).toEqual(sortedIds(sqlite.searchContent))
  expect(sortedIds(markdown.searchBody)).toEqual(sortedIds(sqlite.searchBody))
  expect(sortedIds(markdown.searchReference)).toEqual(sortedIds(sqlite.searchReference))
  expect(sortedIds(markdown.searchKindMiss)).toEqual(sortedIds(sqlite.searchKindMiss))
  expect(sortedIds(markdown.searchEmptyFields)).toEqual(sortedIds(sqlite.searchEmptyFields))
  expect(sortedIds(markdown.searchLimitZero)).toEqual(sortedIds(sqlite.searchLimitZero))
  expect(sortedIds(markdown.searchTagField)).toEqual(sortedIds(sqlite.searchTagField))
  expect(sortedIds(markdown.searchTagDefault)).toEqual(sortedIds(sqlite.searchTagDefault))
  expect(markdown.search).toHaveLength(sqlite.search.length)
  expect(markdown.searchContent).toHaveLength(sqlite.searchContent.length)

  // The shared contract is also the output schema. Both backends must produce
  // values that decode, not merely look similar.
  for (const reads of [sqlite, markdown]) {
    validate(Note.Info, reads.list)
    validate(Note.Info, reads.search)
    validate(Note.TitleInfo, reads.titles)
  }
}

test("SQLite and Markdown NoteService follow the same bounded contract", async () => {
  const seedValues = asciiSeeds()
  const [sqlite, markdown] = await Promise.all([
    sqliteReads(seedValues),
    markdownReads(seedValues),
  ])
  try {
    expect(sqlite.list).toHaveLength(Note.DEFAULT_LIST_LIMIT)
    expect(ids(sqlite.list)).toEqual(
      seedValues
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Note.DEFAULT_LIST_LIMIT)
        .map((seed) => seed.id),
    )
    expect(sqlite.listZero).toHaveLength(1)
    expect(sqlite.listFive).toHaveLength(5)
    expect(ids(sqlite.titles)).toEqual(ids(sqlite.list))
    expect(sqlite.searchLimitZero).toHaveLength(1)
    expect(sqlite.searchEmptyFields).toEqual([])
    expect(sqlite.searchKindMiss).toEqual([])

    // Inputs are validated against the operation schema before the adapter is
    // asked to read, so the contract test exercises the documented wire shape.
    expect(
      Schema.decodeUnknownSync(Note.ListInput)({ limit: 5 }),
    ).toEqual({ limit: 5 })
    expect(
      Schema.decodeUnknownSync(Note.ListTitlesInput)({}),
    ).toEqual({})

    assertEquivalent(sqlite, markdown.reads)
  } finally {
    markdown.cleanup()
  }
})

test("tag matching is an explicit, tested capability split", async () => {
  const seedValues = tagSeeds()
  const [sqlite, markdown] = await Promise.all([
    sqliteReads(seedValues),
    markdownReads(seedValues),
  ])
  try {
    // Default search never includes tags in either implementation, even though
    // the Markdown note actually carries the tag.
    expect(ids(sqlite.searchTagDefault)).toEqual([])
    expect(ids(markdown.reads.searchTagDefault)).toEqual([])

    // SQLite note rows have no tag column, so an explicit tag search cannot
    // match. Markdown stores frontmatter tags and does match.
    expect(ids(sqlite.searchTagField)).toEqual([])
    expect(ids(markdown.reads.searchTagField)).toEqual(["tagged-note"])

    // The declared common fields still agree.
    expect(ids(sqlite.list)).toEqual(ids(markdown.reads.list))
    expect(ids(sqlite.searchBody)).toEqual(["tagged-note"])
    expect(ids(markdown.reads.searchBody)).toEqual(["tagged-note"])
    expect(ids(sqlite.search)).toEqual(ids(markdown.reads.search))
  } finally {
    markdown.cleanup()
  }
})

test("Unicode folding is documented and pinned per implementation", async () => {
  const seedValues = unicodeSeeds()
  const [sqlite, fts] = await Promise.all([
    sqliteReads(seedValues),
    markdownReads(seedValues),
  ])
  const linear = await markdownReads(seedValues, { forceLinearFallback: true })
  try {
    // Exact non-ASCII text matches everywhere.
    expect(ids(sqlite.searchUnicodeExact)).toEqual(["note-one"])
    expect(ids(fts.reads.searchUnicodeExact)).toEqual(["note-one"])
    expect(ids(linear.reads.searchUnicodeExact)).toEqual(["note-one"])

    // SQLite and the Markdown linear fallback fold ASCII case only and match
    // substrings; unicode61 (the FTS5 tokenizer) additionally folds Unicode
    // case and removes Latin diacritics. These assertions pin that split.
    expect(ids(sqlite.searchUnicodeUpper)).toEqual([])
    expect(ids(linear.reads.searchUnicodeUpper)).toEqual([])
    expect(ids(fts.reads.searchUnicodeUpper)).toEqual(["note-one"])

    expect(ids(sqlite.searchUnicodeStripped)).toEqual([])
    expect(ids(linear.reads.searchUnicodeStripped)).toEqual([])
    expect(ids(fts.reads.searchUnicodeStripped)).toEqual(["note-one"])

    expect(ids(sqlite.searchUnicodeCyrillic)).toEqual([])
    expect(ids(sqlite.searchUnicodeCyrillic)).toEqual(
      ids(linear.reads.searchUnicodeCyrillic),
    )
    expect(ids(fts.reads.searchUnicodeCyrillic)).toEqual(["note-two"])
  } finally {
    fts.cleanup()
    linear.cleanup()
  }
})
