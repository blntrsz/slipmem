import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { checkNoteRoot } from "../markdown/check.js"
import { readNoteFile } from "../markdown/paths.js"
import {
  defaultMigrationNoteSerializer,
  importMigration,
  MigrationImportError,
  type MigrationImportReport,
} from "./migration-import"

const fixtureRoot = join(import.meta.dir, "../../fixtures/phase0/migration")
const temporaryDirectories: Array<string> = []
const FIXED_NOW = 1794943845000

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "slipmem-migration-import-"))
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

const manifestFor = (report: MigrationImportReport): Record<string, unknown> => {
  expect(report.manifestPath).not.toBeNull()
  return JSON.parse(readFileSync(report.manifestPath!, "utf8")) as Record<
    string,
    unknown
  >
}

const caughtImport = (
  options: Parameters<typeof importMigration>[0],
): MigrationImportError => {
  try {
    importMigration(options)
  } catch (cause) {
    expect(cause).toBeInstanceOf(MigrationImportError)
    return cause as MigrationImportError
  }
  throw new Error("Expected importMigration to fail.")
}

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .sort()

describe("SQLite to Markdown importer", () => {
  test("a dry run reports the plan without writing anything", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")
    const before = readFileSync(path)

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      dryRun: true,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("dry-run")
    expect(report.ok).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.plan.counts.plannedNotes).toBe(3)
    expect(report.notes.map((note) => note.status)).toEqual([
      "planned",
      "planned",
      "planned",
    ])
    expect(report.counts.writtenNotes).toBe(0)
    expect(report.backup).toBeNull()
    expect(report.runDirectory).toBeNull()
    expect(report.manifestPath).toBeNull()
    expect(report.quarantine.count).toBe(0)
    expect(report.verification.verified).toBe(false)
    expect(report.sourceCheck.unchanged).toBe(true)
    expect(readdirSync(directory)).toEqual(["slipmem.db"])
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test("a WAL dry run reads a db plus WAL copy without creating -shm", () => {
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
      "wal-dry",
      "WAL dry run",
      "Only in the WAL.",
      1794943845000,
      1794943845000,
    ])

    try {
      const copyDirectory = temporaryDirectory()
      const copiedPath = join(copyDirectory, "copied.db")
      copyFileSync(sourcePath, copiedPath)
      copyFileSync(`${sourcePath}-wal`, `${copiedPath}-wal`)
      const before = readdirSync(copyDirectory).sort()

      const report = importMigration({
        databasePath: copiedPath,
        noteRoot: join(copyDirectory, "notes"),
        dryRun: true,
        now: () => FIXED_NOW,
      })

      expect(report.status).toBe("dry-run")
      expect(report.plan.counts.plannedNotes).toBe(1)
      expect(report.sourceCheck.unchanged).toBe(true)
      expect(report.sourceCheck.walBefore.exists).toBe(true)
      expect(readdirSync(copyDirectory).sort()).toEqual(before)
    } finally {
      writer.close()
    }
  })

  test("imports the current fixture and keeps the source unchanged", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")
    const before = readFileSync(path)
    const sourceHash = sha256(before)

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("imported")
    expect(report.ok).toBe(true)
    expect(report.root.nonEmpty).toBe(true)
    expect(report.root.entries).toContain(
      "20261117193045-current-fleeting.md",
    )
    expect(report.counts).toMatchObject({
      sourceRows: 3,
      plannedNotes: 3,
      writtenNotes: 3,
      skippedNotes: 0,
      malformedRows: 0,
      quarantinedRows: 0,
    })
    expect(report.sourceCheck.unchanged).toBe(true)
    expect(report.sourceCheck.after.sha256).toBe(sourceHash)
    expect(report.verification).toMatchObject({
      verified: true,
      ok: true,
      writtenNotes: 3,
      missing: [],
      mismatched: [],
      unexpected: [],
      noteCountBefore: 0,
      noteCountAfter: 3,
    })
    expect(noteFiles(target)).toEqual([
      "20261117193045-current-fleeting.md",
      "20261117201500-current-literature.md",
      "20261117213000-current-permanent.md",
    ])
    expect(readFileSync(path).equals(before)).toBe(true)

    const check = Effect.runSync(checkNoteRoot(target))
    expect(check.ok).toBe(true)
    expect(check.noteCount).toBe(3)

    const fleeting = Effect.runSync(
      readNoteFile(target, "20261117193045-current-fleeting"),
    )
    expect(fleeting).not.toBeNull()
    expect(fleeting?.metadata).toMatchObject({
      type: "fleeting",
      title: "Current fleeting",
      createdAt: "2026-11-17T19:30:45Z",
      updatedAt: "2026-11-17T19:31:42Z",
      legacyId: "current-fleeting",
      provenance: { source: "import" },
    })
    expect(fleeting?.body).toBe("A current-schema fleeting note.")
    expect(fleeting?.unknown["scope"]).toBe("global")

    const literature = Effect.runSync(
      readNoteFile(target, "20261117201500-current-literature"),
    )
    expect(literature?.metadata.reference).toBe("Book, chapter 2")
    expect(literature?.metadata.type).toBe("literature")

    expect(report.backup).not.toBeNull()
    expect(report.backup?.verified).toBe(true)
    expect(report.backup?.tableCounts).toEqual({
      fleeting_note: 1,
      permanent_note: 1,
      literature_note: 1,
    })
    expect(existsSync(report.backup!.path)).toBe(true)
    const backup = new Database(report.backup!.path, { readonly: true })
    try {
      expect(
        backup.query<{ readonly count: number }, []>(
          "SELECT COUNT(*) AS count FROM permanent_note",
        ).get()?.count,
      ).toBe(1)
    } finally {
      backup.close()
    }

    const manifest = manifestFor(report)
    expect(manifest["status"]).toBe("imported")
    expect(manifest["kind"]).toBe("slipmem-migration-manifest")
    expect(manifest["planHash"]).toBe(report.plan.hash)
    expect(manifest["source"]).toMatchObject({ sha256: sourceHash })
    expect(manifest["backup"]).toMatchObject({ verified: true })
    expect(manifest["notes"]).toHaveLength(3)
    expect(manifest["issues"]).toEqual([])
    expect(manifest["quarantine"]).toMatchObject({ count: 0 })
  })

  test("imports the legacy bootstrap fixture and the empty fixture", () => {
    const legacy = createDatabase(fixtureSql("legacy.sql"))
    const legacyTarget = join(legacy.directory, "notes")
    const legacyReport = importMigration({
      databasePath: legacy.path,
      noteRoot: legacyTarget,
      now: () => FIXED_NOW,
    })
    expect(legacyReport.status).toBe("imported")
    expect(legacyReport.plan.source.shape).toBe("bootstrap")
    expect(legacyReport.counts.writtenNotes).toBe(3)
    expect(noteFiles(legacyTarget)).toHaveLength(3)

    const empty = createDatabase(fixtureSql("empty.sql"))
    const emptyTarget = join(empty.directory, "notes")
    const emptyReport = importMigration({
      databasePath: empty.path,
      noteRoot: emptyTarget,
      now: () => FIXED_NOW,
    })
    expect(emptyReport.status).toBe("imported")
    expect(emptyReport.counts.writtenNotes).toBe(0)
    expect(emptyReport.plan.source.shape).toBe("empty")
    expect(emptyReport.backup).not.toBeNull()
    expect(emptyReport.backup?.bytes).toBe(0)
    expect(emptyReport.backup?.verified).toBe(true)
    expect(noteFiles(emptyTarget)).toEqual([])
    expect(manifestFor(emptyReport)["status"]).toBe("imported")
  })

  test("quarantines every malformed row, fails clearly, and never truncates text", () => {
    const { directory, path } = createDatabase(fixtureSql("invalid-rows.sql"))
    const target = join(directory, "notes")
    const before = readFileSync(path)

    const error = caughtImport({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(error.code).toBe("invalid-rows")
    expect(error.report).not.toBeNull()
    const report = error.report!
    expect(report.status).toBe("failed")
    expect(report.ok).toBe(false)
    expect(report.counts.writtenNotes).toBe(0)
    expect(report.counts.malformedRows).toBe(5)
    expect(report.counts.quarantinedRows).toBe(5)
    expect(report.quarantine.files).toHaveLength(5)
    expect(report.quarantine.directory).not.toBeNull()
    expect(report.backup?.verified).toBe(true)
    expect(report.sourceCheck.unchanged).toBe(true)
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(noteFiles(target)).toEqual([])

    const quarantined = new Map<string, Record<string, unknown>>()
    for (const file of report.quarantine.files) {
      const document = JSON.parse(readFileSync(file.path, "utf8")) as Record<
        string,
        unknown
      >
      expect(document["kind"]).toBe("slipmem-migration-invalid-row")
      expect(document["row"]).not.toBeNull()
      quarantined.set(document["legacyId"] as string, document)
    }

    expect(quarantined.get("invalid-blank-title")?.["row"]).toMatchObject({
      title: "   ",
      content: "Text must be preserved.",
    })
    expect(quarantined.get("invalid-blank-content")?.["row"]).toMatchObject({
      content: "",
    })
    expect(quarantined.get("invalid-blank-reference")?.["row"]).toMatchObject({
      reference: "   ",
      content: "A quote without a source.",
    })
    expect(quarantined.get("invalid-time-order")?.["row"]).toMatchObject({
      created_at: 1794943902000,
      updated_at: 1794943845000,
    })
    expect(quarantined.get("invalid-time-range")?.["row"]).toMatchObject({
      content: "Timestamp outside the Date range.",
    })

    const index = JSON.parse(
      readFileSync(join(report.quarantine.directory!, "index.json"), "utf8"),
    ) as Record<string, unknown>
    expect(index["count"]).toBe(5)

    const manifest = manifestFor(report)
    expect(manifest["status"]).toBe("failed")
    expect(manifest["issues"]).toHaveLength(5)
    expect(manifest["quarantine"]).toMatchObject({ count: 5 })
  })

  test("imports valid rows, preserves invalid rows, and reports the failure", () => {
    const { directory, path } = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES
        ('mixed-valid', 'Good note', 'This text is imported.', 1794943845000, 1794943845000),
        ('mixed-invalid', '   ', 'This invalid text must survive.', 1794943846000, 1794943846000);
    `)
    const target = join(directory, "notes")

    const error = caughtImport({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(error.code).toBe("invalid-rows")
    expect(error.report?.counts).toMatchObject({
      sourceRows: 2,
      plannedNotes: 1,
      writtenNotes: 1,
      malformedRows: 1,
      quarantinedRows: 1,
    })
    expect(noteFiles(target)).toEqual(["20261117193045-good-note.md"])
    const imported = Effect.runSync(
      readNoteFile(target, "20261117193045-good-note"),
    )
    expect(imported?.body).toBe("This text is imported.")
    expect(imported?.metadata.legacyId).toBe("mixed-valid")

    const quarantine = JSON.parse(
      readFileSync(error.report!.quarantine.files[0]!.path, "utf8"),
    ) as Record<string, unknown>
    expect(quarantine["legacyId"]).toBe("mixed-invalid")
    expect(quarantine["row"]).toMatchObject({
      title: "   ",
      content: "This invalid text must survive.",
    })
    expect(manifestFor(error.report!)["status"]).toBe("failed")
  })

  test("preserves large integers and blobs in notes and quarantine", () => {
    const { directory, path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        extension_huge INTEGER,
        extension_blob BLOB
      );
      INSERT INTO permanent_note VALUES
        (
          'exact-valid',
          'Exact valid',
          'Body kept.',
          1794943845000,
          1794943845000,
          9223372036854775807,
          x'00ff10'
        ),
        (
          'exact-invalid',
          '   ',
          'Invalid text kept.',
          1794943846000,
          1794943846000,
          -9223372036854775808,
          x'deadbeef'
        );
    `)
    const target = join(directory, "notes")

    const error = caughtImport({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(error.code).toBe("invalid-rows")
    expect(error.report?.counts.writtenNotes).toBe(1)

    const note = Effect.runSync(
      readNoteFile(target, "20261117193045-exact-valid"),
    )
    expect(note?.unknown["legacyColumns"]).toEqual({
      extension_huge: { $bigint: "9223372036854775807" },
      extension_blob: { $base64: "AP8Q" },
    })

    const quarantine = JSON.parse(
      readFileSync(error.report!.quarantine.files[0]!.path, "utf8"),
    ) as Record<string, unknown>
    expect(quarantine["legacyId"]).toBe("exact-invalid")
    expect(quarantine["row"]).toMatchObject({
      extension_huge: { $bigint: "-9223372036854775808" },
      extension_blob: { $base64: "3q2+7w==" },
    })
  })

  test("refuses a non-empty root without merge and writes nothing", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")
    writeFileSync(join(directory, "unrelated.txt"), "keep")
    mkdirSync(target)
    writeFileSync(join(target, "keep.txt"), "existing content")
    const before = readFileSync(path)

    const error = caughtImport({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(error.code).toBe("root-not-empty")
    expect(error.report?.status).toBe("failed")
    expect(error.report?.error).toMatchObject({ code: "root-not-empty" })
    expect(error.report?.dryRun).toBe(false)
    expect(error.report?.counts.plannedNotes).toBe(3)
    expect(error.report?.backup).toBeNull()
    expect(error.report?.manifestPath).toBeNull()
    expect(readdirSync(target)).toEqual(["keep.txt"])
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test("preserves scope, provenance extras, and unknown source columns", () => {
    const { directory, path } = createDatabase(`
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
          'extended-note',
          'Extended note',
          'Extended body',
          1794943845000,
          1794943845000,
          'project:slipmem',
          '{"source":"mcp","actor":"agent","externalId":"ext-1","future":42}',
          'keep me'
        );
    `)
    const target = join(directory, "notes")

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("imported")
    const note = Effect.runSync(
      readNoteFile(target, "20261117193045-extended-note"),
    )
    expect(note?.metadata.provenance).toEqual({
      source: "mcp",
      actor: "agent",
    })
    expect(note?.unknown).toEqual({
      scope: "project:slipmem",
      legacyProvenance: {
        externalId: "ext-1",
        future: 42,
      },
      legacyColumns: {
        extension: "keep me",
      },
    })
    expect(report.verification.ok).toBe(true)
  })

  test("merge mode is idempotent by legacyId and does not duplicate notes", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")

    const first = importMigration({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })
    expect(first.counts.writtenNotes).toBe(3)
    const firstFiles = noteFiles(target)
    const firstContents = new Map(
      firstFiles.map((filename) => [
        filename,
        readFileSync(join(target, filename), "utf8"),
      ]),
    )

    const second = importMigration({
      databasePath: path,
      noteRoot: target,
      merge: true,
      now: () => FIXED_NOW + 1000,
    })

    expect(second.status).toBe("imported")
    expect(second.ok).toBe(true)
    expect(second.counts).toMatchObject({
      plannedNotes: 3,
      writtenNotes: 0,
      skippedNotes: 3,
      failedNotes: 0,
    })
    expect(second.notes.every((note) => note.status === "skipped-legacy-id")).toBe(
      true,
    )
    expect(second.counts.collisions).toBe(0)
    for (const note of second.notes) {
      expect(note.targetPath).toBe(note.existingPath!)
      expect(existsSync(note.targetPath)).toBe(true)
      expect(note.filename).toBe(basename(note.targetPath))
      expect(note.plannedFilename).toBeDefined()
    }
    expect(second.verification.ok).toBe(true)
    expect(second.verification.noteCountBefore).toBe(3)
    expect(second.verification.noteCountAfter).toBe(3)
    expect(noteFiles(target)).toEqual(firstFiles)
    for (const [filename, content] of firstContents) {
      expect(readFileSync(join(target, filename), "utf8")).toBe(content)
    }
    expect(second.manifestPath).not.toBe(first.manifestPath)
    expect(existsSync(second.manifestPath!)).toBe(true)
  })

  test("resolves same-second filename collisions without changing the prefix", () => {
    const { directory, path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO permanent_note VALUES
        ('same-a', 'Same title', 'First body', 1794943845001, 1794943845001),
        ('same-b', 'Same title', 'Second body', 1794943845999, 1794943845999);
    `)
    const target = join(directory, "notes")

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("imported")
    expect(report.counts.writtenNotes).toBe(2)
    expect(report.plan.counts.collisions).toBe(1)
    expect(noteFiles(target)).toEqual([
      "20261117193045-same-title-2.md",
      "20261117193045-same-title.md",
    ])
    const second = Effect.runSync(
      readNoteFile(target, "20261117193045-same-title-2"),
    )
    expect(second?.metadata.legacyId).toBe("same-b")
    expect(second?.metadata.createdAt).toBe("2026-11-17T19:30:45Z")
  })

  test("merge mode suffixes around an existing unrelated filename", () => {
    const { directory, path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO permanent_note VALUES
        ('collision-source', 'Collision note', 'New body', 1794943845000, 1794943845000);
    `)
    const target = join(directory, "notes")
    mkdirSync(target)
    const existing =
      "---\n" +
      "schema: 1\n" +
      "id: 20261117193045-collision-note\n" +
      "type: permanent\n" +
      "title: Existing note\n" +
      'createdAt: "2026-11-17T19:30:45Z"\n' +
      'updatedAt: "2026-11-17T19:30:45Z"\n' +
      "---\n\n" +
      "Existing body\n"
    writeFileSync(join(target, "20261117193045-collision-note.md"), existing)

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      merge: true,
      now: () => FIXED_NOW,
    })

    expect(report.status).toBe("imported")
    expect(report.counts.writtenNotes).toBe(1)
    expect(report.plan.counts.collisions).toBe(1)
    expect(noteFiles(target)).toEqual([
      "20261117193045-collision-note-2.md",
      "20261117193045-collision-note.md",
    ])
    expect(
      readFileSync(join(target, "20261117193045-collision-note.md"), "utf8"),
    ).toBe(existing)
  })

  test("backs up an uncheckpointed WAL source consistently and leaves it unchanged", () => {
    const directory = temporaryDirectory()
    const path = join(directory, "wal.db")
    const writer = new Database(path)
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
      "wal-note",
      "WAL note",
      "Only in the WAL.",
      1794943845000,
      1794943845000,
    ])
    const target = join(directory, "notes")
    const mainBefore = readFileSync(path)
    const walPath = `${path}-wal`
    expect(existsSync(walPath)).toBe(true)
    const walBefore = readFileSync(walPath)

    try {
      const report = importMigration({
        databasePath: path,
        noteRoot: target,
        now: () => FIXED_NOW,
      })

      expect(report.status).toBe("imported")
      expect(report.counts.writtenNotes).toBe(1)
      expect(report.sourceCheck.unchanged).toBe(true)
      expect(report.sourceCheck.walBefore.exists).toBe(true)
      expect(report.sourceCheck.walAfter.sha256).toBe(
        report.sourceCheck.walBefore.sha256,
      )
      expect(report.backup?.verified).toBe(true)
      const backup = new Database(report.backup!.path, { readonly: true })
      try {
        expect(
          backup
            .query<{ readonly content: string }, []>(
              "SELECT content FROM fleeting_note WHERE id = 'wal-note'",
            )
            .get()?.content,
        ).toBe("Only in the WAL.")
      } finally {
        backup.close()
      }
      expect(readFileSync(path).equals(mainBefore)).toBe(true)
      expect(readFileSync(walPath).equals(walBefore)).toBe(true)
    } finally {
      writer.close()
    }
  })

  test("marks an interrupted run and merges the remaining notes", () => {
    const first = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES
        ('incremental-a', 'Incremental A', 'A body.', 1794943845000, 1794943845000);
    `)
    const target = join(first.directory, "notes")
    const firstReport = importMigration({
      databasePath: first.path,
      noteRoot: target,
      now: () => FIXED_NOW,
    })
    expect(firstReport.counts.writtenNotes).toBe(1)

    const crashedRunId = "20260101000000-crashed"
    const crashedDirectory = join(target, ".state", "migrations", crashedRunId)
    mkdirSync(crashedDirectory, { recursive: true })
    const crashedManifest = join(crashedDirectory, "manifest.json")
    writeFileSync(
      crashedManifest,
      JSON.stringify({
        schema: 1,
        kind: "slipmem-migration-manifest",
        runId: crashedRunId,
        pid: 2_147_483_647,
        status: "running",
        notes: [{ status: "imported" }],
      }),
    )

    const full = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES
        ('incremental-a', 'Incremental A', 'A body.', 1794943845000, 1794943845000),
        ('incremental-b', 'Incremental B', 'B body.', 1794943900000, 1794943900000),
        ('incremental-c', 'Incremental C', 'C body.', 1794943950000, 1794943950000);
    `)

    const report = importMigration({
      databasePath: full.path,
      noteRoot: target,
      merge: true,
      now: () => FIXED_NOW + 1000,
    })

    expect(report.status).toBe("imported")
    expect(report.counts).toMatchObject({ writtenNotes: 2, skippedNotes: 1 })
    expect(report.interruptedRuns).toHaveLength(1)
    expect(report.interruptedRuns[0]).toMatchObject({
      runId: crashedRunId,
      marked: true,
      notesWritten: 1,
    })
    expect(report.warnings.map((warning) => warning.code)).toContain(
      "interrupted-run",
    )

    const updated = JSON.parse(readFileSync(crashedManifest, "utf8")) as Record<
      string,
      unknown
    >
    expect(updated["status"]).toBe("interrupted")
    expect(updated["interruptedByRunId"]).toBe(
      basename(report.runDirectory!),
    )
    expect(report.verification.ok).toBe(true)
    expect(noteFiles(target)).toHaveLength(3)
  })

  test("does not mark a running manifest whose owner PID is still alive", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")
    importMigration({ databasePath: path, noteRoot: target, now: () => FIXED_NOW })

    const activeRunId = "20260101000000-active"
    const activeDirectory = join(target, ".state", "migrations", activeRunId)
    mkdirSync(activeDirectory, { recursive: true })
    const activeManifest = join(activeDirectory, "manifest.json")
    writeFileSync(
      activeManifest,
      JSON.stringify({
        schema: 1,
        kind: "slipmem-migration-manifest",
        runId: activeRunId,
        pid: process.pid,
        status: "running",
      }),
    )

    const report = importMigration({
      databasePath: path,
      noteRoot: target,
      merge: true,
      now: () => FIXED_NOW + 1000,
    })

    expect(report.interruptedRuns).toHaveLength(1)
    expect(report.interruptedRuns[0]).toMatchObject({
      runId: activeRunId,
      marked: false,
    })
    expect(report.warnings.map((warning) => warning.code)).toContain(
      "interrupted-run-active",
    )
    expect(
      JSON.parse(readFileSync(activeManifest, "utf8")) as Record<string, unknown>,
    ).toMatchObject({ status: "running" })
  })

  test("fails verification clearly while preserving the manifest and target files", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const target = join(directory, "notes")
    const before = readFileSync(path)
    const seen = new Map<string, number>()
    const serializer = {
      render: defaultMigrationNoteSerializer.render,
      parse: (input: Parameters<typeof defaultMigrationNoteSerializer.parse>[0]) => {
        const count = seen.get(input.path) ?? 0
        seen.set(input.path, count + 1)
        return Effect.map(defaultMigrationNoteSerializer.parse(input), (note) =>
          count === 0 ? note : { ...note, body: `${note.body} tampered` },
        )
      },
    }

    const error = caughtImport({
      databasePath: path,
      noteRoot: target,
      now: () => FIXED_NOW,
      serializer,
    })

    expect(error.code).toBe("verification-failed")
    expect(error.report?.status).toBe("failed")
    expect(error.report?.verification.ok).toBe(false)
    expect(error.report?.verification.notes.some((note) => !note.ok)).toBe(true)
    expect(error.report?.counts.writtenNotes).toBe(3)
    expect(manifestFor(error.report!)["status"]).toBe("failed")
    expect(readFileSync(path).equals(before)).toBe(true)

    const fleeting = Effect.runSync(
      readNoteFile(target, "20261117193045-current-fleeting"),
    )
    expect(fleeting?.body).toBe("A current-schema fleeting note.")
  })
})
