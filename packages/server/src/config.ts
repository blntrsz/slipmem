import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Resolves the SQLite file used by the web app and the stdio MCP server. The
 * shared default keeps both processes reading and writing the same notes.
 */
export const resolveDatabasePath = (): string => {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  const databasePath =
    process.env.SLIPMEM_DB_PATH ?? join(dataHome, "slipmem", "slipmem.db")

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  return databasePath
}
