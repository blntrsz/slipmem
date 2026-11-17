import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
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
  readonly verification: { readonly ok: boolean; readonly writtenNotes: number }
  readonly error: { readonly code: string; readonly message: string } | null
  readonly notes: ReadonlyArray<{
    readonly legacyId: string
    readonly filename: string
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
    expect(
      readdirSync(root).filter((name) => name.endsWith(".md")),
    ).toHaveLength(3)
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
