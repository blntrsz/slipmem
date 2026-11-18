import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, basename, dirname } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface MigrationEnvelope {
  readonly ok: boolean
  readonly dryRun: boolean
  readonly root: string
  readonly report: MigrationReport
}

interface MigrationReport {
  readonly ok: boolean
  readonly dryRun: boolean
  readonly status: string
  readonly root: {
    readonly path: string
    readonly exists: boolean
    readonly nonEmpty: boolean
    readonly mergeRequired: boolean
  }
  readonly plan: {
    readonly counts: {
      readonly sourceRows: number
      readonly plannedNotes: number
      readonly malformedRows: number
      readonly collisions: number
      readonly errors: number
      readonly plannedByType: Record<string, number>
    }
    readonly issues: ReadonlyArray<{
      readonly legacyId: string | null
      readonly row: Readonly<Record<string, unknown>> | null
    }>
  }
  readonly counts: {
    readonly sourceRows: number
    readonly plannedNotes: number
    readonly writtenNotes: number
    readonly skippedNotes: number
    readonly malformedRows: number
    readonly collisions: number
  }
  readonly backup: { readonly path: string; readonly verified: boolean } | null
  readonly sourceCheck: { readonly path: string; readonly unchanged: boolean }
  readonly verification: {
    readonly ok: boolean
    readonly verified: boolean
    readonly writtenNotes: number
  }
  readonly interruptedRuns: ReadonlyArray<{
    readonly runId: string
    readonly manifestPath: string
    readonly pid: number | null
    readonly notesWritten: number
    readonly marked: boolean
  }>
  readonly error: { readonly code: string; readonly message: string } | null
  readonly notes: ReadonlyArray<{
    readonly legacyId: string
    readonly filename: string
    readonly plannedFilename?: string
    readonly targetPath: string
    readonly existingPath?: string
    readonly type: string
    readonly status: string
  }>
}

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

const makeDatabase = (fixture: "current.sql" | "invalid-rows.sql" | "empty.sql"): {
  base: string
  dbPath: string
  sha256: string
} => {
  const base = makeTempBase()
  cleanup.push(base)
  const dbPath = join(base, "legacy.db")
  const database = new Database(dbPath)
  try {
    database.exec(readFileSync(join(FIXTURES, fixture), "utf8"))
  } finally {
    database.close()
  }
  const sha256 = createHash("sha256").update(readFileSync(dbPath)).digest("hex")
  return { base, dbPath, sha256 }
}

const writeFixtureAt = (
  dbPath: string,
  fixture: "current.sql" | "invalid-rows.sql" | "empty.sql" = "current.sql",
): string => {
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new Database(dbPath)
  try {
    database.exec(readFileSync(join(FIXTURES, fixture), "utf8"))
  } finally {
    database.close()
  }
  return dbPath
}

const makeExtendedDatabase = (): { base: string; dbPath: string } => {
  const base = makeTempBase()
  cleanup.push(base)
  const dbPath = join(base, "legacy.db")
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
  return { base, dbPath }
}

const run = (
  base: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
) =>
  runCliProcess(args, {
    cwd: base,
    env: {
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
      ...env,
    },
  })

describe("slipmem migrate sqlite", () => {
  test("dry run reports the plan without creating or changing anything", async () => {
    const { base, dbPath, sha256 } = makeDatabase("current.sql")
    const root = join(base, ".slipmem")

    const result = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--dry-run",
      "--json",
    ])
    expect(result.code).toBe(0)
    const report = parseJson<MigrationEnvelope>(result.stdout).report
    expect(report).toMatchObject({
      ok: true,
      dryRun: true,
      status: "dry-run",
    })
    expect(report.counts).toMatchObject({
      sourceRows: 3,
      plannedNotes: 3,
      writtenNotes: 0,
      malformedRows: 0,
    })
    expect(report.plan.counts.plannedByType).toEqual({
      fleeting: 1,
      permanent: 1,
      literature: 1,
    })
    expect(report.notes.map((note) => note.legacyId).sort()).toEqual([
      "current-fleeting",
      "current-literature",
      "current-permanent",
    ])
    expect(existsSync(root)).toBe(false)
    expect(
      createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    ).toBe(sha256)
  })

  test("resolves the migration source from --db, SLIPMEM_DB_PATH, then XDG data", async () => {
    const base = makeTempBase()
    cleanup.push(base)
    const envPath = join(base, "env", "slipmem.db")
    const xdgPath = join(base, "xdg", "slipmem", "slipmem.db")
    const explicitPath = writeFixtureAt(join(base, "explicit", "slipmem.db"))
    writeFixtureAt(envPath)
    writeFixtureAt(xdgPath)
    const xdgSha = createHash("sha256").update(readFileSync(xdgPath)).digest("hex")

    const env = {
      XDG_DATA_HOME: join(base, "xdg"),
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
      SLIPMEM_DB_PATH: envPath,
    }

    const fromExplicit = await run(
      base,
      [
        "migrate",
        "sqlite",
        "--db",
        explicitPath,
        "--dir",
        join(base, "explicit-root"),
        "--json",
      ],
      env,
    )
    expect(fromExplicit.code).toBe(0)
    expect(parseJson<MigrationEnvelope>(fromExplicit.stdout).report.sourceCheck.path).toBe(
      explicitPath,
    )

    const fromEnv = await run(
      base,
      ["migrate", "sqlite", "--dir", join(base, "env-root"), "--json"],
      env,
    )
    expect(fromEnv.code).toBe(0)
    expect(parseJson<MigrationEnvelope>(fromEnv.stdout).report.sourceCheck.path).toBe(
      envPath,
    )

    const fromXdg = await run(
      base,
      ["migrate", "sqlite", "--dir", join(base, "xdg-root"), "--json"],
      { XDG_DATA_HOME: join(base, "xdg"), XDG_CACHE_HOME: join(base, "cache"), XDG_STATE_HOME: join(base, "state") },
    )
    expect(fromXdg.code).toBe(0)
    expect(parseJson<MigrationEnvelope>(fromXdg.stdout).report.sourceCheck.path).toBe(
      xdgPath,
    )
    expect(
      createHash("sha256").update(readFileSync(xdgPath)).digest("hex"),
    ).toBe(xdgSha)

    const missing = await run(
      base,
      ["migrate", "sqlite", "--dir", join(base, "missing-root"), "--json"],
      {
        XDG_DATA_HOME: join(base, "no-data"),
        XDG_CACHE_HOME: join(base, "cache"),
        XDG_STATE_HOME: join(base, "state"),
      },
    )
    expect(missing.code).toBe(1)
    expect(existsSync(join(base, "missing-root", ".slipmem"))).toBe(false)

    const memory = await run(
      base,
      ["migrate", "sqlite", "--dir", join(base, "memory-root"), "--json"],
      {
        SLIPMEM_DB_PATH: ":memory:",
        XDG_CACHE_HOME: join(base, "cache"),
        XDG_STATE_HOME: join(base, "state"),
      },
    )
    expect(memory.code).toBe(2)
    expect(memory.stderr).toContain("file-backed")
  })

  test("imports atomically with a verified backup and then skips duplicates in merge mode", async () => {
    const { base, dbPath, sha256 } = makeDatabase("current.sql")
    const root = join(base, ".slipmem")

    const imported = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--json",
    ])
    expect(imported.code).toBe(0)
    const report = parseJson<MigrationEnvelope>(imported.stdout).report
    expect(report).toMatchObject({
      ok: true,
      dryRun: false,
      status: "imported",
    })
    expect(report.counts.writtenNotes).toBe(3)
    expect(report.verification).toMatchObject({ ok: true, writtenNotes: 3 })
    expect(report.backup?.verified).toBe(true)
    expect(report.backup?.path).toContain("source-backup.db")
    expect(
      readdirSync(root).filter((name) => name.endsWith(".md")),
    ).toHaveLength(3)
    expect(
      createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    ).toBe(sha256)

    const check = await run(base, ["check", "--dir", root, "--json"])
    expect(check.code).toBe(0)

    const second = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--json",
    ])
    expect(second.code).toBe(1)
    const refused = parseJson<{ report: MigrationReport }>(second.stdout)
    expect(refused.report.error?.code).toBe("root-not-empty")

    const refusedHuman = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
    ])
    expect(refusedHuman.code).toBe(1)
    expect(refusedHuman.stdout).toContain("root-not-empty")
    expect(refusedHuman.stdout).toContain("verification: not run")
    expect(refusedHuman.stdout).not.toContain("verification: OK")

    const merged = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--merge",
      "--json",
    ])
    expect(merged.code).toBe(0)
    const mergedReport = parseJson<MigrationEnvelope>(merged.stdout).report
    expect(mergedReport.counts.writtenNotes).toBe(0)
    expect(mergedReport.counts.skippedNotes).toBe(3)
    expect(mergedReport.counts.collisions).toBe(0)
    expect(mergedReport.interruptedRuns).toEqual([])
    expect(
      readdirSync(root).filter((name) => name.endsWith(".md")),
    ).toHaveLength(3)
    for (const note of mergedReport.notes) {
      expect(note.status).toBe("skipped-legacy-id")
      expect(existsSync(note.targetPath)).toBe(true)
      expect(basename(note.targetPath)).toBe(note.filename)
      expect(note.existingPath).toBe(note.targetPath)
      expect(note.targetPath).not.toMatch(/-2\.md$/)
    }

    const mergedHuman = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--merge",
    ])
    expect(mergedHuman.code).toBe(0)
    expect(mergedHuman.stdout).toContain("collisions (effective): 0")
    for (const note of mergedReport.notes) {
      expect(mergedHuman.stdout).toContain(`target: ${note.targetPath}`)
    }
  })

  test("renders interrupted runs, effective collisions, and portable source values", async () => {
    const { base, dbPath } = makeDatabase("current.sql")
    const root = join(base, ".slipmem")
    const seedInterrupted = (runId: string): string => {
      const run = join(root, ".state", "migrations", runId)
      mkdirSync(run, { recursive: true })
      const manifestPath = join(run, "manifest.json")
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            kind: "slipmem-migration-manifest",
            runId,
            status: "running",
            pid: 2147483646,
            notes: [{ status: "imported" }],
          },
          null,
          2,
        )}\n`,
      )
      return manifestPath
    }

    const firstManifest = seedInterrupted("20200101000000-old")
    const human = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
    ])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("Interrupted runs (1):")
    expect(human.stdout).toContain("20200101000000-old")
    expect(human.stdout).toContain("manifest marked interrupted")
    expect(existsSync(firstManifest)).toBe(true)

    const secondManifest = seedInterrupted("20200101000001-old")
    const result = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--merge",
      "--json",
    ])
    expect(result.code).toBe(0)
    const report = parseJson<MigrationEnvelope>(result.stdout).report
    expect(report.interruptedRuns).toHaveLength(1)
    expect(report.interruptedRuns[0]).toMatchObject({
      runId: "20200101000001-old",
      notesWritten: 1,
      marked: true,
    })
    expect(existsSync(secondManifest)).toBe(true)

    const extended = makeExtendedDatabase()
    const encoded = await run(extended.base, [
      "migrate",
      "sqlite",
      "--db",
      extended.dbPath,
      "--dir",
      join(extended.base, ".slipmem"),
      "--dry-run",
      "--json",
    ])
    expect(encoded.code).toBe(0)
    expect(encoded.stdout).toContain('"$bigint": "9223372036854775807"')
    expect(encoded.stdout).toContain('"$base64": "AP8Q"')
  })

  test("reports malformed rows without truncating or dropping their source data", async () => {
    const { base, dbPath } = makeDatabase("invalid-rows.sql")
    const root = join(base, ".slipmem")

    const result = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      dbPath,
      "--dir",
      root,
      "--dry-run",
      "--json",
    ])
    expect(result.code).toBe(1)
    const report = parseJson<MigrationEnvelope>(result.stdout).report
    expect(report.ok).toBe(false)
    expect(report.plan.counts.malformedRows).toBe(5)
    expect(report.plan.counts.errors).toBeGreaterThan(0)
    expect(report.plan.issues).toHaveLength(5)
    for (const issue of report.plan.issues) {
      expect(issue.row).not.toBeNull()
      expect(Object.keys(issue.row!).length).toBeGreaterThan(0)
    }
    expect(existsSync(root)).toBe(false)
  })

  test("reports a missing source and rejects an unknown migration kind", async () => {
    const base = makeTempBase()
    cleanup.push(base)
    const missing = await run(base, [
      "migrate",
      "sqlite",
      "--db",
      join(base, "missing.db"),
      "--dir",
      join(base, ".slipmem"),
      "--dry-run",
      "--json",
    ])
    expect(missing.code).toBe(1)
    const envelope = parseJson<{ error: { kind: string; code: string } }>(
      missing.stderr,
    )
    expect(envelope.error).toMatchObject({
      kind: "migration",
      code: "missing",
    })

    const unknown = await run(base, ["migrate", "postgres", "--db", "x", "--json"])
    expect(unknown.code).toBe(2)
    expect(
      parseJson<{ error: { kind: string } }>(unknown.stderr).error.kind,
    ).toBe("usage")
  }, 30000)
})
