import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Resolves the SQLite file used by the web app. The default matches the stdio
 * MCP server so both processes read and write the same notes.
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
