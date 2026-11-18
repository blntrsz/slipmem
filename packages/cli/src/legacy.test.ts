import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

const FIXTURES = resolve(
  import.meta.dir,
  "../../core/fixtures/phase0/migration",
)

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const makeDatabase = (fixture: "current.sql" | "invalid-rows.sql"): {
  base: string
  dbPath: string
  sha256: string
} => {
  const base = makeTempBase()
  cleanup.push(base)
  return { base, ...writeDatabaseAt(join(base, "legacy.db"), fixture) }
}

const writeDatabaseAt = (
  dbPath: string,
  fixture: "current.sql" | "invalid-rows.sql" = "current.sql",
): { dbPath: string; sha256: string } => {
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new Database(dbPath)
  try {
    database.exec(readFileSync(join(FIXTURES, fixture), "utf8"))
  } finally {
    database.close()
  }
  return {
    dbPath,
    sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
  }
}

const run = (
  base: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  runCliProcess(args, {
    cwd: base,
    env: {
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
      ...env,
    },
  })

interface LegacyRow {
  readonly type: string
  readonly legacyId: string | null
  readonly valid: boolean
  readonly problems: ReadonlyArray<{ readonly code: string }>
  readonly note: {
    readonly title: string
    readonly body: string
    readonly reference: string | null
    readonly createdAtIso: string
    readonly updatedAtIso: string
  } | null
}

interface LegacyEnvelope {
  readonly ok: boolean
  readonly warning: string
  readonly report: {
    readonly compatibility: string
    readonly readOnly: boolean
    readonly source: { readonly path: string; readonly sha256: string }
    readonly type: string | null
    readonly total?: number
    readonly rows?: ReadonlyArray<LegacyRow>
    readonly row?: LegacyRow | null
    readonly warnings: ReadonlyArray<{ readonly code: string }>
  }
}

describe("slipmem legacy compatibility commands", () => {
  test("lists the retired rows with an explicit read-only warning", async () => {
    const { base, dbPath, sha256 } = makeDatabase("current.sql")

    const result = await run(base, [
      "legacy",
      "list",
      "--db",
      dbPath,
      "--json",
    ])
    expect(result.code).toBe(0)
    const envelope = parseJson<LegacyEnvelope>(result.stdout)
    expect(envelope.warning).toContain("one-release")
    expect(envelope.report).toMatchObject({
      compatibility: "one-release-read-only",
      readOnly: true,
      type: null,
      total: 3,
    })
    expect(envelope.report.source.path).toBe(dbPath)
    expect(envelope.report.rows!.map((row) => row.legacyId).sort()).toEqual([
      "current-fleeting",
      "current-literature",
      "current-permanent",
    ])
    expect(
      envelope.report.warnings.map((warning) => warning.code),
    ).toContain("read-only-one-release")
    expect(
      createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    ).toBe(sha256)
    expect(existsSync(join(base, ".slipmem"))).toBe(false)

    const human = await run(base, ["legacy", "list", "--db", dbPath])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("LEGACY READ-ONLY (one release)")
    expect(human.stdout).toContain("never imports")
    expect(human.stdout).toContain("current-permanent")
  }, 30000)

  test("shows one typed legacy row and reports a missing row without writing", async () => {
    const { base, dbPath } = makeDatabase("current.sql")

    const shown = await run(base, [
      "legacy",
      "show",
      "--db",
      dbPath,
      "--type",
      "literature",
      "--id",
      "current-literature",
      "--json",
    ])
    expect(shown.code).toBe(0)
    const envelope = parseJson<LegacyEnvelope>(shown.stdout)
    expect(envelope.report.row).toMatchObject({
      type: "literature",
      legacyId: "current-literature",
      valid: true,
      note: {
        reference: "Book, chapter 2",
        body: "A current-schema literature note.",
      },
    })
    expect(envelope.report.row?.note?.createdAtIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    )

    const human = await run(base, [
      "legacy",
      "show",
      "--db",
      dbPath,
      "--type",
      "literature",
      "--id",
      "current-literature",
    ])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("LEGACY READ-ONLY")
    expect(human.stdout).toContain("A current-schema literature note.")

    const missing = await run(base, [
      "legacy",
      "show",
      "--db",
      dbPath,
      "--type",
      "permanent",
      "--id",
      "does-not-exist",
      "--json",
    ])
    expect(missing.code).toBe(1)
    const missingEnvelope = parseJson<{
      ok: boolean
      error: { kind: string; code: string }
    }>(missing.stdout)
    expect(missingEnvelope.ok).toBe(false)
    expect(missingEnvelope.error).toMatchObject({
      kind: "not-found",
      code: "legacy-not-found",
    })
    expect(existsSync(join(base, ".slipmem"))).toBe(false)
  }, 30000)

  test("tags unsafe integers and blobs, resolves the default source, and rejects bad options", async () => {
    const base = makeTempBase()
    cleanup.push(base)
    const dbPath = join(base, "xdg", "slipmem", "slipmem.db")
    mkdirSync(dirname(dbPath), { recursive: true })
    const database = new Database(dbPath)
    try {
      database.exec(`
        CREATE TABLE permanent_note (
          id text PRIMARY KEY NOT NULL,
          title text NOT NULL,
          content text NOT NULL,
          created_at real NOT NULL,
          updated_at real NOT NULL,
          extension_huge INTEGER,
          extension_blob BLOB
        );
        INSERT INTO permanent_note
          (id, title, content, created_at, updated_at, extension_huge, extension_blob)
        VALUES
          ('extended-permanent', 'Extended permanent', 'A note with extra columns.',
           1794951000000, 1794951060000, 9223372036854775807, X'00FF10');
      `)
    } finally {
      database.close()
    }

    const fromXdg = await run(
      base,
      ["legacy", "list", "--type", "permanent", "--json"],
      { XDG_DATA_HOME: join(base, "xdg") },
    )
    expect(fromXdg.code).toBe(0)
    expect(fromXdg.stdout).toContain('"$bigint": "9223372036854775807"')
    expect(fromXdg.stdout).toContain('"$base64": "AP8Q"')
    expect(parseJson<LegacyEnvelope>(fromXdg.stdout).report.source.path).toBe(
      dbPath,
    )

    const invalidType = await run(base, [
      "legacy",
      "list",
      "--db",
      dbPath,
      "--type",
      "unknown",
      "--json",
    ])
    expect(invalidType.code).toBe(2)

    const invalidLimit = await run(base, [
      "legacy",
      "list",
      "--db",
      dbPath,
      "--limit",
      "101",
      "--json",
    ])
    expect(invalidLimit.code).toBe(2)

    const invalidOffset = await run(base, [
      "legacy",
      "list",
      "--db",
      dbPath,
      "--offset",
      "-1",
      "--json",
    ])
    expect(invalidOffset.code).toBe(2)

    const dirRefused = await run(base, [
      "legacy",
      "list",
      "--db",
      dbPath,
      "--dir",
      join(base, ".slipmem"),
      "--json",
    ])
    expect(dirRefused.code).toBe(2)
    expect(dirRefused.stderr).toContain("does not use --dir")

    const memory = await run(
      base,
      ["legacy", "list", "--json"],
      { SLIPMEM_DB_PATH: ":memory:" },
    )
    expect(memory.code).toBe(2)
    expect(memory.stderr).toContain("file-backed")

    const missingSource = await run(base, [
      "legacy",
      "list",
      "--db",
      join(base, "missing.db"),
      "--json",
    ])
    expect(missingSource.code).toBe(1)
    expect(
      parseJson<{ error: { kind: string; code: string } }>(missingSource.stderr)
        .error.kind,
    ).toBe("migration")
  }, 30000)
})
