import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { usageError } from "./errors.js"

const DEFAULT_DATABASE_FILENAME = "slipmem.db"

/**
 * Resolves a read-only SQLite source with the Phase 5 priority: explicit
 * `--db`, then `SLIPMEM_DB_PATH` relative to the caller, then
 * `$XDG_DATA_HOME/slipmem/slipmem.db` (falling back to
 * `~/.local/share/slipmem/slipmem.db`). It never creates the source directory
 * or database; callers report a missing source through their own reader.
 */
export const resolveSourceDatabasePath = (
  cwd: string,
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  command: string,
): string => {
  const fromFlag = explicit?.trim()
  const fromEnv = env.SLIPMEM_DB_PATH?.trim()
  if (explicit !== undefined && fromFlag === "") {
    throw usageError(
      "--db requires a non-empty database path. Omit --db to use SLIPMEM_DB_PATH or the XDG data default.",
      command,
    )
  }

  let value: string
  if (fromFlag !== undefined && fromFlag !== "") {
    value = fromFlag
  } else if (fromEnv !== undefined && fromEnv !== "") {
    value = fromEnv
  } else {
    const dataHome =
      env.XDG_DATA_HOME?.trim() ||
      join(env.HOME?.trim() || homedir(), ".local", "share")
    value = join(dataHome, "slipmem", DEFAULT_DATABASE_FILENAME)
  }

  if (value === ":memory:") {
    throw usageError(
      "This command needs a file-backed SQLite source; :memory: cannot be read. Pass --db <path> or set SLIPMEM_DB_PATH.",
      command,
    )
  }
  return resolve(cwd, value)
}
