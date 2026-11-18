import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Markdown } from "@slipmem/schemas/markdown"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MigrationSourceError,
  planMigration,
  type MigrationPlan,
  type PlannedMigrationNote,
} from "./migration-plan"

const fixtureRoot = join(import.meta.dir, "../../fixtures/phase0/migration")
const temporaryDirectories: Array<string> = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "slipmem-migration-"))
  temporaryDirectories.push(directory)
  return directory
}

const fixtureSql = (name: string): string =>
  readFileSync(join(fixtureRoot, name), "utf8")

const createDatabase = (
  sql: string,
  filename = "slipmem.db",
): { readonly directory: string; readonly path: string } => {
  const directory = temporaryDirectory()
  const path = join(directory, filename)
  const database = new Database(path)
  try {
    if (sql.replace(/--.*$/gm, "").trim().length > 0) {
      database.exec(sql)
    }
  } finally {
    database.close()
  }
  return { directory, path }
}

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

const noteFor = (
  plan: MigrationPlan,
  legacyId: string,
): PlannedMigrationNote => {
  const note = plan.notes.find((candidate) => candidate.legacyId === legacyId)
  expect(note).toBeDefined()
  return note!
}

const problemCodes = (plan: MigrationPlan): ReadonlyArray<string> =>
  plan.issues.flatMap((issue) =>
    issue.problems.map((entry) => `${issue.legacyId ?? "(table)"}:${entry.code}`),
  )

describe("SQLite migration planning", () => {
  test("maps the current fixture read-only without creating target files", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const targetRoot = join(directory, "target")
    const before = readFileSync(path)

    const plan = planMigration({ databasePath: path, noteRoot: targetRoot })
    const after = readFileSync(path)

    expect(after.equals(before)).toBe(true)
    expect(plan.source.sha256).toBe(sha256(before))
    expect(plan.source.bytes).toBe(before.length)
    expect(plan.source.shape).toBe("bootstrap")
    expect(plan.source.tables.map((table) => [table.name, table.rowCount])).toEqual([
      ["fleeting_note", 1],
      ["permanent_note", 1],
      ["literature_note", 1],
    ])
    expect(readdirSync(directory)).toEqual(["slipmem.db"])
    expect(() => readdirSync(targetRoot)).toThrow()

    expect(plan.counts).toMatchObject({
      sourceRows: 3,
      plannedNotes: 3,
      malformedRows: 0,
      issues: 0,
      errors: 0,
      warnings: 0,
      collisions: 0,
      sourceByType: { fleeting: 1, permanent: 1, literature: 1 },
      plannedByType: { fleeting: 1, permanent: 1, literature: 1 },
      malformedByType: { fleeting: 0, permanent: 0, literature: 0 },
    })
    expect(plan.issues).toEqual([])
    expect(plan.collisions).toEqual([])
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/)

    const fleeting = noteFor(plan, "current-fleeting")
    expect(fleeting.type).toBe("fleeting")
    expect(fleeting.filename).toBe("20261117193045-current-fleeting.md")
    expect(fleeting.targetPath).toBe(
      join(targetRoot, "20261117193045-current-fleeting.md"),
    )
    expect(fleeting.body).toBe("A current-schema fleeting note.")
    expect(fleeting.metadata).toMatchObject({
      schema: 1,
      id: "20261117193045-current-fleeting",
      type: "fleeting",
      title: "Current fleeting",
      createdAt: "2026-11-17T19:30:45Z",
      updatedAt: "2026-11-17T19:31:42Z",
      legacyId: "current-fleeting",
      provenance: { source: "import" },
    })
    expect(fleeting.metadata.reference).toBeUndefined()
    expect(fleeting.preservation).toEqual({
      scope: "global",
      provenanceExtras: {},
      columns: {},
    })

    const literature = noteFor(plan, "current-literature")
    expect(literature.type).toBe("literature")
    expect(literature.filename).toBe("20261117201500-current-literature.md")
    expect(literature.body).toBe("A current-schema literature note.")
    expect(literature.metadata.reference).toBe("Book, chapter 2")
    expect(literature.metadata.createdAt).toBe("2026-11-17T20:15:00Z")

    const permanent = noteFor(plan, "current-permanent")
    expect(permanent.type).toBe("permanent")
    expect(permanent.filename).toBe("20261117213000-current-permanent.md")
    expect(permanent.body).toBe("A current-schema permanent note.")
    expect(permanent.metadata.createdAt).toBe("2026-11-17T21:30:00Z")

    for (const note of plan.notes) {
      expect(note.metadata.id).toBe(Markdown.noteIdFromFilename(note.filename)!)
      expect(note.metadata.id).toBe(note.filename.slice(0, -3))
      expect(note.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(note.sourceRowHash).toMatch(/^[0-9a-f]{64}$/)
    }

    const second = planMigration({ databasePath: path, noteRoot: targetRoot })
    expect(second.hash).toBe(plan.hash)
    expect(second.notes).toEqual(plan.notes)
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(() => readdirSync(targetRoot)).toThrow()
  })

  test("maps the legacy bootstrap fixture with the same file rules", () => {
    const { path } = createDatabase(fixtureSql("legacy.sql"))
    const plan = planMigration({ databasePath: path })

    expect(plan.source.shape).toBe("bootstrap")
    expect(plan.counts.plannedNotes).toBe(3)
    expect(plan.counts.malformedRows).toBe(0)

    expect(
      plan.notes.map((note) => [
        note.legacyId,
        note.type,
        note.filename,
        note.targetPath,
      ]),
    ).toEqual([
      [
        "legacy-fleeting",
        "fleeting",
        "20261117193045-legacy-fleeting.md",
        join(".slipmem", "20261117193045-legacy-fleeting.md"),
      ],
      [
        "legacy-literature",
        "literature",
        "20261117201500-legacy-literature.md",
        join(".slipmem", "20261117201500-legacy-literature.md"),
      ],
      [
        "legacy-permanent",
        "permanent",
        "20261117213000-legacy-permanent.md",
        join(".slipmem", "20261117213000-legacy-permanent.md"),
      ],
    ])
    expect(noteFor(plan, "legacy-literature").metadata.reference).toBe(
      "Legacy book",
    )
  })

  test("returns a complete but empty plan for an empty database", () => {
    const { directory, path } = createDatabase(fixtureSql("empty.sql"))
    const plan = planMigration({
      databasePath: path,
      noteRoot: join(directory, "target"),
    })

    expect(plan.source.shape).toBe("empty")
    expect(plan.source.bytes).toBe(0)
    expect(plan.source.tables).toEqual([])
    expect(plan.notes).toEqual([])
    expect(plan.issues).toEqual([])
    expect(plan.collisions).toEqual([])
    expect(plan.counts.sourceRows).toBe(0)
    expect(plan.counts.plannedNotes).toBe(0)
    expect(plan.counts.malformedRows).toBe(0)
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(() => readdirSync(join(directory, "target"))).toThrow()
  })

  test("reports every malformed fixture row with its complete text", () => {
    const { directory, path } = createDatabase(fixtureSql("invalid-rows.sql"))
    const plan = planMigration({
      databasePath: path,
      noteRoot: join(directory, "target"),
    })

    expect(plan.notes).toEqual([])
    expect(plan.counts.sourceRows).toBe(5)
    expect(plan.counts.plannedNotes).toBe(0)
    expect(plan.counts.malformedRows).toBe(5)
    expect(plan.counts.issues).toBe(5)
    expect(plan.counts.sourceByType).toEqual({
      fleeting: 2,
      permanent: 2,
      literature: 1,
    })
    expect(plan.counts.malformedByType).toEqual({
      fleeting: 2,
      permanent: 2,
      literature: 1,
    })
    expect(new Set(problemCodes(plan))).toEqual(
      new Set([
        "invalid-blank-title:blank-title",
        "invalid-blank-content:blank-content",
        "invalid-blank-reference:blank-reference",
        "invalid-time-order:updated-before-created",
        "invalid-time-range:invalid-created-at",
        "invalid-time-range:invalid-updated-at",
      ]),
    )

    const byId = new Map(
      plan.issues.map((issue) => [issue.legacyId, issue] as const),
    )
    expect(byId.get("invalid-blank-title")?.row).toMatchObject({
      title: "   ",
      content: "Text must be preserved.",
    })
    expect(byId.get("invalid-blank-content")?.row).toMatchObject({
      content: "",
    })
    expect(byId.get("invalid-blank-reference")?.row).toMatchObject({
      reference: "   ",
      content: "A quote without a source.",
    })
    expect(byId.get("invalid-time-order")?.row).toMatchObject({
      created_at: 1794943902000,
      updated_at: 1794943845000,
    })
    expect(byId.get("invalid-time-range")?.row).toMatchObject({
      content: "Timestamp outside the Date range.",
    })

    for (const issue of plan.issues) {
      expect(issue.severity).toBe("error")
      expect(issue.row).not.toBeNull()
      expect(issue.rowIndex).not.toBeNull()
    }
    expect(() => readdirSync(join(directory, "target"))).toThrow()
  })

  test("resolves whole-second collisions while keeping the timestamp prefix", () => {
    const { path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO permanent_note VALUES
        ('collision-a', 'Same title', 'First body', 1794943845001, 1794943845001),
        ('collision-b', 'Same title', 'Second body', 1794943845999, 1794943845999),
        ('collision-c', 'Same title', 'Third body', 1794943846000, 1794943846000);
    `)

    const plan = planMigration({ databasePath: path })

    expect(plan.notes.map((note) => note.filename)).toEqual([
      "20261117193045-same-title.md",
      "20261117193045-same-title-2.md",
      "20261117193046-same-title.md",
    ])
    expect(plan.counts.collisions).toBe(1)
    expect(plan.collisions).toEqual([
      {
        source: {
          table: "permanent_note",
          rowIndex: 1,
          legacyId: "collision-b",
        },
        baseFilename: "20261117193045-same-title.md",
        filename: "20261117193045-same-title-2.md",
      },
    ])
    expect(noteFor(plan, "collision-b").metadata.createdAt).toBe(
      "2026-11-17T19:30:45Z",
    )

    const withExisting = planMigration({
      databasePath: path,
      takenFilenames: ["20261117193045-same-title.md"],
    })
    expect(withExisting.notes.map((note) => note.filename)).toEqual([
      "20261117193045-same-title-2.md",
      "20261117193045-same-title-3.md",
      "20261117193046-same-title.md",
    ])
    expect(withExisting.counts.collisions).toBe(2)
  })

  test("preserves scope, provenance extras, and unknown source columns", () => {
    const { path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        scope TEXT NOT NULL,
        provenance TEXT NOT NULL,
        extension TEXT
      );
      INSERT INTO permanent_note VALUES
        (
          'scoped-valid',
          'Scoped note',
          'Scoped body',
          1794943845000,
          1794943845000,
          'project:slipmem',
          '{"source":"mcp","actor":"agent","externalId":"ext-1","future":42}',
          'keep me'
        ),
        (
          'scoped-invalid',
          'Broken metadata',
          'Text is still imported',
          1794943846000,
          1794943846000,
          '   ',
          'not json',
          NULL
        );
    `)

    const plan = planMigration({ databasePath: path })

    expect(plan.source.shape).toBe("extended")
    expect(plan.source.tables[0]?.shape).toBe("extended")
    expect(plan.counts.plannedNotes).toBe(2)
    expect(plan.counts.malformedRows).toBe(0)
    expect(plan.counts.warnings).toBe(2)

    const valid = noteFor(plan, "scoped-valid")
    expect(valid.metadata.provenance).toEqual({
      source: "mcp",
      actor: "agent",
    })
    expect(valid.preservation).toEqual({
      scope: "project:slipmem",
      provenanceExtras: {
        externalId: "ext-1",
        future: 42,
      },
      columns: {
        extension: "keep me",
      },
    })

    const invalid = noteFor(plan, "scoped-invalid")
    expect(invalid.body).toBe("Text is still imported")
    expect(invalid.metadata.provenance).toEqual({ source: "import" })
    expect(invalid.preservation).toEqual({
      scope: "global",
      provenanceExtras: {},
      columns: {
        extension: null,
        scope: "   ",
        provenance: "not json",
      },
    })
    expect(problemCodes(plan)).toEqual([
      "scoped-invalid:invalid-scope",
      "scoped-invalid:invalid-provenance",
    ])
  })

  test("plans WAL-only rows from a copied db plus WAL without creating -shm", () => {
    const sourceDirectory = temporaryDirectory()
    const sourcePath = join(sourceDirectory, "wal.db")
    const writer = new Database(sourcePath)
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
    `)
    writer.run("INSERT INTO fleeting_note VALUES (?, ?, ?, ?, ?)", [
      "wal-only",
      "WAL only",
      "This row lives only in the WAL.",
      1794943845000,
      1794943845000,
    ])

    try {
      // A copied database plus WAL, deliberately without -shm, in its own
      // directory. The planner must not create a sidecar next to it.
      const copyDirectory = temporaryDirectory()
      const copiedPath = join(copyDirectory, "copied.db")
      copyFileSync(sourcePath, copiedPath)
      copyFileSync(`${sourcePath}-wal`, `${copiedPath}-wal`)
      const before = readdirSync(copyDirectory).sort()
      expect(before).toEqual(["copied.db", "copied.db-wal"])
      chmodSync(copyDirectory, 0o555)

      try {
        const plan = planMigration({ databasePath: copiedPath })

        expect(plan.counts.plannedNotes).toBe(1)
        expect(plan.notes[0]?.legacyId).toBe("wal-only")
        expect(plan.notes[0]?.body).toBe("This row lives only in the WAL.")
        expect(readdirSync(copyDirectory).sort()).toEqual(before)
      } finally {
        chmodSync(copyDirectory, 0o755)
      }
    } finally {
      writer.close()
    }
  })

  test("preserves integers above 2^53 and blobs exactly", () => {
    const { path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        extension_huge INTEGER,
        extension_blob BLOB
      );
      INSERT INTO permanent_note VALUES
        (
          'exact-integer',
          'Exact integer',
          'Body kept exactly.',
          1794943845000,
          1794943845001,
          9223372036854775807,
          x'00ff10'
        );
    `)

    const plan = planMigration({ databasePath: path })

    expect(plan.counts.plannedNotes).toBe(1)
    const note = noteFor(plan, "exact-integer")
    expect(note.metadata.createdAt).toBe("2026-11-17T19:30:45Z")
    expect(note.metadata.updatedAt).toBe("2026-11-17T19:30:45Z")
    expect(note.preservation.columns["extension_huge"]).toBe(
      9223372036854775807n,
    )
    expect(note.preservation.columns["extension_blob"]).toEqual(
      new Uint8Array([0, 255, 16]),
    )

    // The exact bigint/blob identity participates in the deterministic hashes.
    const second = planMigration({ databasePath: path })
    expect(second.hash).toBe(plan.hash)
    expect(noteFor(second, "exact-integer").sourceRowHash).toBe(
      note.sourceRowHash,
    )
  })

  test("preserves raw provenance text containing an unsafe integer", () => {
    const raw = '{"source":"mcp","externalId":9223372036854775807}'
    const { path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        provenance TEXT NOT NULL
      );
      INSERT INTO permanent_note VALUES
        (
          'unsafe-provenance',
          'Unsafe provenance',
          'Exact raw JSON is retained.',
          1794943845000,
          1794943845000,
          '${raw}'
        );
    `)

    const plan = planMigration({ databasePath: path })

    const note = noteFor(plan, "unsafe-provenance")
    expect(note.metadata.provenance).toEqual({ source: "mcp" })
    expect(note.preservation.columns["provenance"]).toBe(raw)
    expect(note.preservation.provenanceExtras).toEqual({})
    expect(problemCodes(plan)).toContain("unsafe-provenance:invalid-provenance")
  })

  test("reports an incompatible table shape instead of failing", () => {
    const { path } = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES ('broken', 'Broken', 1, 1);
    `)

    const plan = planMigration({ databasePath: path })

    expect(plan.notes).toEqual([])
    expect(plan.counts.sourceRows).toBe(1)
    expect(plan.counts.malformedRows).toBe(1)
    expect(plan.counts.errors).toBe(2)
    expect(plan.counts.sourceByType.fleeting).toBe(1)
    expect(plan.counts.malformedByType.fleeting).toBe(1)
    expect(plan.source.shape).toBe("unrecognized")
    expect(plan.source.tables).toEqual([
      {
        name: "fleeting_note",
        rowCount: 1,
        columns: ["id", "title", "created_at", "updated_at"],
        shape: "unrecognized",
      },
    ])
    expect(plan.issues).toHaveLength(2)
    expect(plan.issues[0]).toMatchObject({
      table: "fleeting_note",
      rowIndex: null,
      severity: "error",
      row: null,
      problems: [
        {
          severity: "error",
          code: "missing-required-column",
        },
      ],
    })
    expect(plan.issues[0]?.problems[0]?.message).toContain("content")

    // The row itself is preserved even though the table cannot be mapped.
    expect(plan.issues[1]).toMatchObject({
      table: "fleeting_note",
      rowIndex: 0,
      legacyId: "broken",
      severity: "error",
      row: {
        id: "broken",
        title: "Broken",
        created_at: 1,
        updated_at: 1,
      },
    })
  })

  test("raises a typed error for a missing source", () => {
    const directory = temporaryDirectory()
    const path = join(directory, "absent.db")

    expect(() => planMigration({ databasePath: path })).toThrow(
      MigrationSourceError,
    )

    try {
      planMigration({ databasePath: path })
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationSourceError)
      expect((error as MigrationSourceError).code).toBe("missing")
    }
  })
})
