import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Markdown } from "@slipmem/schemas/markdown"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

interface ValidNoteFixture {
  readonly file: string
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly topics: ReadonlyArray<string>
  readonly reference: string | null
  readonly unknownKeys: ReadonlyArray<string>
  readonly bodyIncludes: string
}

interface InvalidNoteFixture {
  readonly file: string
  readonly expected: {
    readonly area: "filename" | "frontmatter" | "metadata" | "body"
    readonly code: string
  }
}

interface NotesManifest {
  readonly schema: number
  readonly frozenAt: string
  readonly valid: ReadonlyArray<ValidNoteFixture>
  readonly invalid: ReadonlyArray<InvalidNoteFixture>
}

interface MigrationFixture {
  readonly file: string
  readonly shape: "current" | "legacy" | "empty"
  readonly noteTables: ReadonlyArray<string>
  readonly rows: Readonly<Record<string, number>>
}

interface MigrationManifest {
  readonly schema: number
  readonly fixtures: ReadonlyArray<MigrationFixture>
  readonly expectedMappings: ReadonlyArray<{
    readonly source: string
    readonly targetType: Markdown.NoteType
    readonly legacyId: string
    readonly createdAt: string
    readonly reference?: string
  }>
}

interface AcceptanceExamples {
  readonly schema: number
  readonly cli: Readonly<Record<string, unknown>>
  readonly api: Readonly<Record<string, { readonly request: { readonly method: string; readonly path: string } }>>
  readonly mcp: Readonly<
    Record<
      string,
      {
        readonly tool: string
        readonly arguments: Readonly<Record<string, unknown>>
        readonly result: Readonly<Record<string, unknown>>
      }
    >
  >
}

const fixtureRoot = join(import.meta.dir, "../../fixtures/phase0")
const notesRoot = join(fixtureRoot, "notes")
const migrationRoot = join(fixtureRoot, "migration")

const readJson = <A>(path: string): A =>
  JSON.parse(readFileSync(path, "utf8")) as A

const notesManifest = readJson<NotesManifest>(join(fixtureRoot, "notes.manifest.json"))
const migrationManifest = readJson<MigrationManifest>(
  join(migrationRoot, "manifest.json"),
)
const acceptanceExamples = readJson<AcceptanceExamples>(
  join(fixtureRoot, "acceptance/examples.json"),
)

const splitFrontmatter = (content: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  expect(match).not.toBeNull()
  return { yaml: match![1], body: match![2] }
}

const frontmatterValue = (yaml: string, key: string): string | null => {
  const line = yaml
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}:`))
  if (line === undefined) {
    return null
  }

  const raw = line.slice(key.length + 1).trim()
  return /^".*"$/.test(raw) ? raw.slice(1, -1) : raw
}

const prefixFor = (timestamp: string): string =>
  Markdown.toUtcTimestamp(Date.parse(timestamp)).filenamePrefix

const filesIn = (path: string): ReadonlyArray<string> => readdirSync(path).sort()

describe("Phase 0 note fixture corpus", () => {
  test("the manifest lists every fixture and nothing stale", () => {
    expect(filesIn(join(notesRoot, "valid"))).toEqual(
      notesManifest.valid.map((fixture) => basename(fixture.file)).sort(),
    )
    expect(filesIn(join(notesRoot, "invalid"))).toEqual(
      notesManifest.invalid.map((fixture) => basename(fixture.file)).sort(),
    )
    expect(notesManifest.schema).toBe(1)
    expect(notesManifest.frozenAt).toBe("2026-11-17T21:05:00Z")
  })

  test("valid notes obey filenames, timestamps, metadata, and body limits", () => {
    for (const fixture of notesManifest.valid) {
      const path = join(notesRoot, fixture.file)
      const filename = basename(path)
      const content = readFileSync(path, "utf8")
      const { yaml, body } = splitFrontmatter(content)

      expect(Markdown.isNoteFilename(filename)).toBe(true)
      expect(Markdown.noteIdFromFilename(filename)).toBe(fixture.id)
      expect(fixture.id).toBe(`${prefixFor(fixture.createdAt)}-${fixture.id.slice(15)}`)

      expect(frontmatterValue(yaml, "schema")).toBe("1")
      expect(frontmatterValue(yaml, "id")).toBe(fixture.id)
      expect(frontmatterValue(yaml, "type")).toBe(fixture.type)
      expect(frontmatterValue(yaml, "title")).toBe(fixture.title)
      expect(frontmatterValue(yaml, "createdAt")).toBe(fixture.createdAt)
      expect(frontmatterValue(yaml, "updatedAt")).toBe(fixture.updatedAt)
      expect(fixture.updatedAt >= fixture.createdAt).toBe(true)

      for (const topic of fixture.topics) {
        expect(yaml).toContain(`  - ${topic}`)
        expect(Markdown.isTopicSlug(topic)).toBe(true)
      }

      if (fixture.reference !== null) {
        expect(frontmatterValue(yaml, "reference")).toBe(fixture.reference)
      }

      for (const unknownKey of fixture.unknownKeys) {
        expect(yaml).toContain(`${unknownKey}:`)
      }

      expect(body).toContain(fixture.bodyIncludes)
      expect(body.trim().length).toBeGreaterThan(0)
      expect(body.trim().length).toBeLessThanOrEqual(
        Markdown.CONTENT_LIMITS[fixture.type],
      )
    }
  })

  test("the corpus covers every note type", () => {
    expect(new Set(notesManifest.valid.map((fixture) => fixture.type))).toEqual(
      new Set(Markdown.NOTE_TYPES),
    )
  })

  test("same-second titles produce deterministic collision suffixes", () => {
    const cafeNotes = notesManifest.valid.filter(
      (fixture) => fixture.title === "Café notes",
    )

    expect(cafeNotes).toHaveLength(2)
    expect(cafeNotes[0]!.createdAt).toBe(cafeNotes[1]!.createdAt)
    expect(cafeNotes.map((fixture) => fixture.id)).toEqual([
      "20261117213000-cafe-notes",
      "20261117213000-cafe-notes-2",
    ])

    expect(
      Markdown.noteFilename({
        title: "Café notes",
        createdAt: Date.parse("2026-11-17T21:30:00Z"),
        taken: ["20261117213000-cafe-notes.md"],
      }),
    ).toBe("20261117213000-cafe-notes-2.md")
  })

  test("Unicode and long titles match the frozen slug algorithm", () => {
    const unicode = notesManifest.valid.find((fixture) => fixture.title === "Café notes")!
    const long = notesManifest.valid.find(
      (fixture) => fixture.title.length > Markdown.MAX_SLUG_LENGTH,
    )!

    expect(Markdown.slugifyTitle(unicode.title)).toBe("cafe-notes")
    expect(Markdown.slugifyTitle(long.title)).toBe(long.id.slice(15))
    expect(long.id.slice(15).length).toBeLessThanOrEqual(Markdown.MAX_SLUG_LENGTH)
    expect(
      Markdown.noteFilename({
        title: long.title,
        createdAt: Date.parse(long.createdAt),
      }),
    ).toBe(`${long.id}.md`)
  })

  test("invalid notes fail only the named contract area", () => {
    for (const fixture of notesManifest.invalid) {
      const path = join(notesRoot, fixture.file)
      const filename = basename(path)
      const content = readFileSync(path, "utf8")

      if (fixture.expected.area === "filename") {
        expect(Markdown.isNoteFilename(filename)).toBe(false)
        continue
      }

      expect(Markdown.isNoteFilename(filename)).toBe(true)
      const { yaml, body } = splitFrontmatter(content)

      switch (fixture.expected.code) {
        case "malformed-yaml":
          expect(yaml).toContain('title: "unterminated')
          break
        case "conflict-markers":
          expect(body).toContain("<<<<<<< HEAD")
          expect(body).toContain("=======")
          expect(body).toContain(">>>>>>> incoming")
          break
        case "missing-reference":
          expect(frontmatterValue(yaml, "type")).toBe("literature")
          expect(frontmatterValue(yaml, "reference")).toBeNull()
          break
        case "id-mismatch":
          expect(frontmatterValue(yaml, "id")).not.toBe(
            Markdown.noteIdFromFilename(filename),
          )
          break
        case "timestamp-mismatch":
          expect(prefixFor(frontmatterValue(yaml, "createdAt")!)).not.toBe(
            filename.slice(0, 14),
          )
          break
        case "blank-title":
          expect(frontmatterValue(yaml, "title")!.trim()).toBe("")
          break
        case "unknown-type":
          expect(Markdown.NOTE_TYPES).not.toContain(frontmatterValue(yaml, "type"))
          break
        case "content-too-long":
          expect(body.trim().length).toBeGreaterThan(
            Markdown.CONTENT_LIMITS.fleeting,
          )
          break
        case "executable-yaml":
          expect(yaml).toContain("!!")
          break
        default:
          throw new Error(`Unhandled fixture expectation: ${fixture.expected.code}`)
      }
    }
  })
})

describe("Phase 0 SQLite migration fixtures", () => {
  test("the manifest lists every fixture", () => {
    expect(filesIn(migrationRoot).filter((file) => file.endsWith(".sql"))).toEqual(
      migrationManifest.fixtures.map((fixture) => fixture.file).sort(),
    )
    expect(migrationManifest.schema).toBe(1)
  })

  test("each fixture has the declared shape and row counts", () => {
    for (const fixture of migrationManifest.fixtures) {
      const db = new Database(":memory:")

      try {
        const sql = readFileSync(join(migrationRoot, fixture.file), "utf8")
        if (sql.replace(/--.*$/gm, "").trim().length > 0) {
          db.exec(sql)
        }
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name)

        expect(tables).toEqual([...fixture.noteTables].sort())

        for (const [table, expectedCount] of Object.entries(fixture.rows)) {
          const count = db
            .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
            .get()!.count
          expect(count).toBe(expectedCount)
        }

        for (const table of fixture.noteTables) {
          const columns = db
            .query<{ name: string; type: string; notnull: number; pk: number }, []>(
              `PRAGMA table_info(${table})`,
            )
            .all()
          expect(columns[0]).toMatchObject({
            name: "id",
            type: "TEXT",
            notnull: 1,
            pk: 1,
          })
        }
      } finally {
        db.close()
      }
    }
  })

  test("migration expectations use contract timestamps", () => {
    for (const mapping of migrationManifest.expectedMappings) {
      expect(Markdown.NOTE_TYPES).toContain(mapping.targetType)
      expect(Markdown.toUtcTimestamp(Date.parse(mapping.createdAt)).isoTimestamp).toBe(
        mapping.createdAt,
      )
      expect(mapping.legacyId).not.toBe("")
    }
  })
})

describe("Phase 0 acceptance payload fixtures", () => {
  test("examples cover CLI, API, and MCP surfaces", () => {
    expect(acceptanceExamples.schema).toBe(1)
    expect(Object.keys(acceptanceExamples.cli).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(acceptanceExamples.api).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(acceptanceExamples.mcp).length).toBeGreaterThanOrEqual(5)

    for (const example of Object.values(acceptanceExamples.api)) {
      expect(example.request.path.startsWith("/api/")).toBe(true)
      expect(example.request.method.length).toBeGreaterThan(0)
    }
  })

  test("permanent and delete MCP writes stay pending approval", () => {
    expect(acceptanceExamples.mcp.createPermanent!.tool).toBe(
      "create_permanent_note",
    )
    expect(acceptanceExamples.mcp.createPermanent!.result.status).toBe(
      "pending_approval",
    )
    expect(acceptanceExamples.mcp.deleteAny!.result.status).toBe("pending_approval")
    expect(Object.keys(acceptanceExamples.mcp)).not.toContain("approve_proposal")
  })
})
