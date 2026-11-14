import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const fixtureDirectory = resolve(
  import.meta.dir,
  "../../../tests/fixtures/scoped-memory",
)

interface FixtureNote {
  readonly key: string
  readonly kind: "fleeting" | "literature" | "permanent"
  readonly id: string
  readonly scope: string
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly createdAt: number
  readonly updatedAt: number
}

interface FixtureCorpus {
  readonly fixtureVersion: number
  readonly scopes: Readonly<Record<string, string>>
  readonly notes: ReadonlyArray<FixtureNote>
}

interface SearchCase {
  readonly id: string
  readonly query: string
  readonly scope: string | null
  readonly kind: FixtureNote["kind"] | null
  readonly limit: number | null
  readonly expectedKeys?: ReadonlyArray<string>
  readonly expectedKeysSubset?: ReadonlyArray<string>
  readonly expectedCount?: number
  readonly ordering: string
}

interface SearchCases {
  readonly fixtureVersion: number
  readonly cases: ReadonlyArray<SearchCase>
  readonly openQuestions: ReadonlyArray<string>
}

interface LegacyManifest {
  readonly fixtureVersion: number
  readonly notes: ReadonlyArray<Omit<FixtureNote, "scope">>
  readonly invariants: ReadonlyArray<string>
}

const readJson = async <A>(name: string): Promise<A> =>
  JSON.parse(await readFile(join(fixtureDirectory, name), "utf8")) as A

const contentLimits = {
  fleeting: 1000,
  literature: 5000,
  permanent: 2000,
} as const

test("the scoped-memory corpus is internally consistent", async () => {
  const corpus = await readJson<FixtureCorpus>("corpus.json")

  expect(corpus.fixtureVersion).toBe(1)
  expect(corpus.notes.length).toBeGreaterThan(0)

  const keys = corpus.notes.map((note) => note.key)
  const ids = corpus.notes.map((note) => note.id)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(ids).size).toBe(ids.length)

  const scopes = new Set(Object.values(corpus.scopes))
  for (const note of corpus.notes) {
    expect(scopes.has(note.scope)).toBe(true)
    expect(note.id).toBe(note.key)
    expect(note.title.trim().length).toBeGreaterThan(0)
    expect(note.content.trim().length).toBeGreaterThan(0)
    expect(note.content.length).toBeLessThanOrEqual(contentLimits[note.kind])
    expect(Number.isFinite(note.createdAt)).toBe(true)
    expect(Number.isFinite(note.updatedAt)).toBe(true)

    if (note.kind === "literature") {
      expect(note.reference?.trim().length).toBeGreaterThan(0)
    } else {
      expect(note.reference).toBeUndefined()
    }
  }

  expect(new Set(corpus.notes.map((note) => note.kind))).toEqual(
    new Set(["fleeting", "literature", "permanent"]),
  )
})

test("every search case references corpus keys and valid filters", async () => {
  const corpus = await readJson<FixtureCorpus>("corpus.json")
  const searchCases = await readJson<SearchCases>("search-cases.json")
  const keys = new Set(corpus.notes.map((note) => note.key))
  const kinds = new Set(corpus.notes.map((note) => note.kind))
  const scopes = new Set(Object.values(corpus.scopes))

  expect(searchCases.fixtureVersion).toBe(1)
  expect(new Set(searchCases.cases.map((entry) => entry.id)).size).toBe(
    searchCases.cases.length,
  )
  expect(searchCases.openQuestions.length).toBeGreaterThan(0)

  for (const entry of searchCases.cases) {
    expect(entry.query.length).toBeGreaterThan(0)
    expect(entry.scope === null || scopes.has(entry.scope)).toBe(true)
    expect(entry.kind === null || kinds.has(entry.kind)).toBe(true)
    expect(entry.limit === null || (entry.limit > 0 && Number.isInteger(entry.limit))).toBe(true)

    for (const key of entry.expectedKeys ?? []) {
      expect(keys.has(key)).toBe(true)
    }
    for (const key of entry.expectedKeysSubset ?? []) {
      expect(keys.has(key)).toBe(true)
    }
    if (entry.expectedKeys !== undefined) {
      expect(new Set(entry.expectedKeys).size).toBe(entry.expectedKeys.length)
    }
    if (entry.expectedCount !== undefined) {
      expect(entry.expectedKeysSubset).toBeDefined()
      expect(entry.expectedCount).toBeLessThanOrEqual(
        entry.expectedKeysSubset!.length,
      )
    }
  }

  // The exact-key cases must cover scope isolation, kind filtering, reference
  // indexing, unicode, punctuation, and the unsafe query shape.
  const ids = new Set(searchCases.cases.map((entry) => entry.id))
  for (const required of [
    "SEARCH-01",
    "SEARCH-03",
    "SEARCH-06",
    "SEARCH-07",
    "SEARCH-09",
    "SEARCH-10",
    "SEARCH-11",
  ]) {
    expect(ids.has(required)).toBe(true)
  }
})

test("the legacy fixture loads in the frozen bootstrap shape and matches its manifest", async () => {
  const manifest = await readJson<LegacyManifest>("legacy-v1.manifest.json")
  const sql = await readFile(join(fixtureDirectory, "legacy-v1.sql"), "utf8")
  const directory = await mkdtemp(join(tmpdir(), "slipmem-scope-fixture-"))
  const databasePath = join(directory, "legacy.db")
  const db = new Database(databasePath)

  try {
    db.exec(sql)

    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["fleeting_note", "literature_note", "permanent_note"])

    const rows = [
      ...db
        .query<{
          id: string
          title: string
          content: string
          created_at: number
          updated_at: number
        }, []>(
          "SELECT id, title, content, created_at, updated_at FROM fleeting_note",
        )
        .all()
        .map((row) => ({ ...row, kind: "fleeting" as const, reference: undefined })),
      ...db
        .query<{
          id: string
          title: string
          content: string
          created_at: number
          updated_at: number
        }, []>(
          "SELECT id, title, content, created_at, updated_at FROM permanent_note",
        )
        .all()
        .map((row) => ({ ...row, kind: "permanent" as const, reference: undefined })),
      ...db
        .query<{
          id: string
          title: string
          content: string
          reference: string
          created_at: number
          updated_at: number
        }, []>(
          "SELECT id, title, content, reference, created_at, updated_at FROM literature_note",
        )
        .all()
        .map((row) => ({ ...row, kind: "literature" as const })),
    ]

    const byManifest = new Map(
      manifest.notes.map((note) => [`${note.kind}:${note.id}`, note]),
    )
    expect(rows).toHaveLength(manifest.notes.length)

    for (const row of rows) {
      const expected = byManifest.get(`${row.kind}:${row.id}`)
      expect(expected).toBeDefined()
      expect(row.title).toBe(expected!.title)
      expect(row.content).toBe(expected!.content)
      expect(row.reference).toBe(expected!.reference)
      expect(row.created_at).toBe(expected!.createdAt)
      expect(row.updated_at).toBe(expected!.updatedAt)
    }

    // Two permanent notes intentionally share a title and timestamps. They
    // must remain distinct rows after any future migration.
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM permanent_note WHERE title = 'Legacy search target'",
        )
        .get()!.count,
    ).toBe(2)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
