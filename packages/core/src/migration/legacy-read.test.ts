import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getLegacyNote,
  LEGACY_READ_COMPATIBILITY,
  LEGACY_READ_MAX_LIMIT,
  listLegacyNotes,
} from "./legacy-read.js"

const fixtureRoot = join(import.meta.dir, "../../fixtures/phase0/migration")
const temporaryDirectories: Array<string> = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "slipmem-legacy-read-"))
  temporaryDirectories.push(directory)
  return directory
}

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

const fixtureSql = (name: string): string =>
  readFileSync(join(fixtureRoot, name), "utf8")

describe("read-only legacy compatibility reader", () => {
  test("lists and gets valid rows without writing to the source", () => {
    const { directory, path } = createDatabase(fixtureSql("current.sql"))
    const before = readFileSync(path)
    const sourceHash = sha256(before)

    const firstPage = listLegacyNotes({ databasePath: path, limit: 2 })
    expect(firstPage.schema).toBe(1)
    expect(firstPage.compatibility).toBe(LEGACY_READ_COMPATIBILITY)
    expect(firstPage.readOnly).toBe(true)
    expect(firstPage.source).toMatchObject({
      path,
      bytes: before.length,
      sha256: sourceHash,
    })
    expect(firstPage.type).toBeNull()
    expect(firstPage.limit).toBe(2)
    expect(firstPage.offset).toBe(0)
    expect(firstPage.total).toBe(3)
    expect(firstPage.rows).toHaveLength(2)
    expect(firstPage.rows.map((row) => row.type)).toEqual([
      "fleeting",
      "permanent",
    ])
    expect(firstPage.rows.map((row) => row.valid)).toEqual([true, true])
    expect(firstPage.rows[0]?.legacyId).toBe("current-fleeting")
    expect(firstPage.rows[0]?.note).toMatchObject({
      type: "fleeting",
      legacyId: "current-fleeting",
      title: "Current fleeting",
      body: "A current-schema fleeting note.",
      reference: null,
      createdAt: 1794943845000,
      updatedAt: 1794943902000,
      createdAtIso: "2026-11-17T19:30:45Z",
      updatedAtIso: "2026-11-17T19:31:42Z",
      scope: "global",
      provenance: { source: "import" },
    })
    expect(firstPage.rows[0]?.raw).toMatchObject({
      id: "current-fleeting",
      title: "Current fleeting",
    })
    expect(firstPage.rows[0]?.problems).toEqual([])
    expect(firstPage.warnings[0]?.code).toBe("read-only-one-release")

    const secondPage = listLegacyNotes({
      databasePath: path,
      limit: 2,
      offset: 2,
    })
    expect(secondPage.total).toBe(3)
    expect(secondPage.rows.map((row) => row.type)).toEqual(["literature"])
    expect(secondPage.rows[0]?.note).toMatchObject({
      title: "Current literature",
      reference: "Book, chapter 2",
    })

    const permanentOnly = listLegacyNotes({
      databasePath: path,
      type: "permanent",
    })
    expect(permanentOnly.type).toBe("permanent")
    expect(permanentOnly.total).toBe(1)
    expect(permanentOnly.rows[0]?.legacyId).toBe("current-permanent")

    const fetched = getLegacyNote({
      databasePath: path,
      type: "literature",
      legacyId: "current-literature",
    })
    expect(fetched.readOnly).toBe(true)
    expect(fetched.row?.valid).toBe(true)
    expect(fetched.row?.note).toMatchObject({
      title: "Current literature",
      body: "A current-schema literature note.",
      reference: "Book, chapter 2",
      createdAt: 1794946500000,
      updatedAt: 1794946560000,
    })
    expect(
      getLegacyNote({
        databasePath: path,
        type: "fleeting",
        legacyId: "current-literature",
      }).row,
    ).toBeNull()

    expect(readFileSync(path).equals(before)).toBe(true)
    expect(sha256(readFileSync(path))).toBe(sourceHash)
    expect(readdirSync(directory)).toEqual(["slipmem.db"])
    expect(existsSync(join(directory, ".slipmem"))).toBe(false)
  })

  test("returns invalid rows raw with planner warnings instead of skipping them", () => {
    const { path } = createDatabase(`
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO permanent_note VALUES
        ('valid-row', 'Valid row', 'Valid body', 1794943845000, 1794943845000),
        ('blank-title', '   ', 'Text must survive', 1794943846000, 1794943846000),
        ('bad-time', 'Bad time', 'Time must be reported', 1e20, 1794943846000);
    `)

    const listed = listLegacyNotes({ databasePath: path })
    expect(listed.total).toBe(3)
    expect(listed.rows.map((row) => row.legacyId)).toEqual([
      "bad-time",
      "blank-title",
      "valid-row",
    ])
    expect(listed.rows.map((row) => row.valid)).toEqual([
      false,
      false,
      true,
    ])

    const blank = listed.rows.find((row) => row.legacyId === "blank-title")!
    expect(blank.note).toBeNull()
    expect(blank.raw).toMatchObject({
      title: "   ",
      content: "Text must survive",
    })
    expect(blank.problems.map((problem) => problem.code)).toEqual([
      "blank-title",
    ])
    expect(blank.problems[0]?.message).toContain("not imported")

    const badTime = listed.rows.find((row) => row.legacyId === "bad-time")!
    expect(badTime.note).toBeNull()
    expect(badTime.problems.map((problem) => problem.code)).toContain(
      "invalid-created-at",
    )

    const fetched = getLegacyNote({
      databasePath: path,
      type: "permanent",
      legacyId: "blank-title",
    })
    expect(fetched.row?.raw).toMatchObject({ title: "   " })
    expect(fetched.row?.valid).toBe(false)
    expect(fetched.row?.note).toBeNull()
  })

  test("keeps the same legacy ID distinct across note types", () => {
    const { path } = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE permanent_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES
        ('shared-id', 'Fleeting shared', 'fleeting body', 1794943845000, 1794943845000);
      INSERT INTO permanent_note VALUES
        ('shared-id', 'Permanent shared', 'permanent body', 1794943846000, 1794943846000);
    `)

    const listed = listLegacyNotes({ databasePath: path })
    expect(listed.total).toBe(2)
    expect(
      listed.rows.map((row) => [row.type, row.legacyId, row.note?.title]),
    ).toEqual([
      ["fleeting", "shared-id", "Fleeting shared"],
      ["permanent", "shared-id", "Permanent shared"],
    ])

    const fleeting = getLegacyNote({
      databasePath: path,
      type: "fleeting",
      legacyId: "shared-id",
    })
    const permanent = getLegacyNote({
      databasePath: path,
      type: "permanent",
      legacyId: "shared-id",
    })
    expect(fleeting.row?.note?.body).toBe("fleeting body")
    expect(permanent.row?.note?.body).toBe("permanent body")
    expect(fleeting.row?.note?.type).toBe("fleeting")
    expect(permanent.row?.note?.type).toBe("permanent")
  })

  test("shows rows from a malformed table raw and never fails a get without id", () => {
    const { path } = createDatabase(`
      CREATE TABLE fleeting_note (
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      INSERT INTO fleeting_note VALUES
        ('No id row', 'Raw text survives', 1794943845000, 1794943845000);
    `)

    const listed = listLegacyNotes({ databasePath: path })
    expect(listed.total).toBe(1)
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0]).toMatchObject({
      legacyId: null,
      valid: false,
      note: null,
    })
    expect(listed.rows[0]?.raw).toMatchObject({
      title: "No id row",
      content: "Raw text survives",
    })
    expect(listed.rows[0]?.problems.map((problem) => problem.code)).toContain(
      "invalid-id",
    )
    expect(listed.warnings.map((warning) => warning.code)).toEqual([
      "read-only-one-release",
      "missing-required-column",
    ])

    const fetched = getLegacyNote({
      databasePath: path,
      type: "fleeting",
      legacyId: "missing",
    })
    expect(fetched.row).toBeNull()
    expect(fetched.warnings.map((warning) => warning.code)).toEqual([
      "read-only-one-release",
      "missing-required-column",
    ])
  })

  test("reads a copied WAL source without creating -shm or changing bytes", () => {
    const source = createDatabase(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
    `)
    const writer = new Database(source.path)
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
      writer
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("wal-row", "WAL row", "Only in the WAL", 1794943845000, 1794943845000)

      const directory = temporaryDirectory()
      const copyPath = join(directory, "copied.db")
      copyFileSync(source.path, copyPath)
      copyFileSync(`${source.path}-wal`, `${copyPath}-wal`)
      const before = readdirSync(directory).sort()
      const mainHash = sha256(readFileSync(copyPath))
      const walHash = sha256(readFileSync(`${copyPath}-wal`))

      const listed = listLegacyNotes({ databasePath: copyPath })
      expect(listed.total).toBe(1)
      expect(listed.rows[0]?.legacyId).toBe("wal-row")
      expect(listed.rows[0]?.note?.body).toBe("Only in the WAL")

      expect(readdirSync(directory).sort()).toEqual(before)
      expect(existsSync(`${copyPath}-shm`)).toBe(false)
      expect(sha256(readFileSync(copyPath))).toBe(mainHash)
      expect(sha256(readFileSync(`${copyPath}-wal`))).toBe(walHash)
    } finally {
      writer.close()
    }
  })

  test("bounds paging options and requires a typed non-empty id for get", () => {
    const { path } = createDatabase(fixtureSql("empty.sql"))

    expect(() => listLegacyNotes({ databasePath: path, limit: 0 })).toThrow(
      RangeError,
    )
    expect(() =>
      listLegacyNotes({ databasePath: path, limit: LEGACY_READ_MAX_LIMIT + 1 }),
    ).toThrow(RangeError)
    expect(() => listLegacyNotes({ databasePath: path, offset: -1 })).toThrow(
      RangeError,
    )
    expect(() =>
      listLegacyNotes({ databasePath: path, type: "unknown" as never }),
    ).toThrow(RangeError)
    expect(() =>
      getLegacyNote({
        databasePath: path,
        type: "fleeting",
        legacyId: "",
      }),
    ).toThrow(RangeError)

    const empty = listLegacyNotes({ databasePath: path })
    expect(empty.total).toBe(0)
    expect(empty.rows).toEqual([])
    expect(empty.warnings.map((warning) => warning.code)).toEqual([
      "read-only-one-release",
    ])
    expect(
      getLegacyNote({
        databasePath: path,
        type: "fleeting",
        legacyId: "missing",
      }).warnings.map((warning) => warning.code),
    ).toEqual(["read-only-one-release", "missing-note-table"])
  })
})
