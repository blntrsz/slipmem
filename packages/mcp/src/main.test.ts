import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../../..")

const migrationsApplied = (databasePath: string): boolean => {
  try {
    const db = new Database(databasePath, { readonly: true })
    try {
      return (
        db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("__drizzle_migrations") !== null
      )
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

const waitForMigrations = async (databasePath: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (migrationsApplied(databasePath)) return
    await Bun.sleep(10)
  }

  throw new Error(`Migrations did not complete for ${databasePath}`)
}

test("stdio server exits cleanly on SIGTERM and SIGINT", async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
    const databasePath = join(directory, "notes.db")
    const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
      cwd: repositoryRoot,
      env: { ...process.env, SLIPMEM_DB_PATH: databasePath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(server.stdout).text()
    const stderr = new Response(server.stderr).text()

    try {
      await waitForMigrations(databasePath)
      server.kill(signal)
      expect(await server.exited).toBe(0)
      expect(await stdout).toBe("")
      expect(await stderr).toBe("")
    } finally {
      server.kill("SIGKILL")
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("stdio startup failures go to stderr and leave stdout untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const databasePath = join(directory, "notes.db")
  const missingMigrations = join(directory, "missing-migrations")
  const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SLIPMEM_DB_PATH: databasePath,
      SLIPMEM_MIGRATIONS_DIR: missingMigrations,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(server.stdout).text()
  const stderr = new Response(server.stderr).text()

  try {
    const [exitCode, output, errors] = await Promise.all([
      server.exited,
      stdout,
      stderr,
    ])

    expect(exitCode).not.toBe(0)
    expect(output).toBe("")
    expect(errors).toContain("MigrationError")
    expect(errors).toContain(missingMigrations)
  } finally {
    server.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
})
