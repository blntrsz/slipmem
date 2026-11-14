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

test("stdio server exits cleanly on SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const databasePath = join(directory, "notes.db")
  const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env: { ...process.env, SLIPMEM_DB_PATH: databasePath },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })

  try {
    await waitForMigrations(databasePath)
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    server.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
})
