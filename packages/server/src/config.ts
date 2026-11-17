import { resolveNoteRoot } from "@slipmem/core"
import { Effect } from "effect"
import { mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Resolves the SQLite file used only by the migration importer and the
 * pre-cutover compatibility path. Markdown surfaces no longer read this path.
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

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface NoteRootPathOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
}

/**
 * Resolves the Markdown note root for a long-running surface.
 *
 * Unlike `slipmem init`, startup never creates a repository implicitly. A
 * missing root is an actionable error: the operator should run `slipmem init`
 * or set `SLIPMEM_DIR`.
 */
export const resolveNoteRootPath = (
  options: NoteRootPathOptions = {},
): string => {
  const resolution = Effect.runSync(
    resolveNoteRoot({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
  )

  if (!isDirectory(resolution.root)) {
    throw new Error(
      `No Markdown note repository at ${resolution.root}. Run "slipmem init" or set SLIPMEM_DIR to an existing .slipmem directory.`,
    )
  }

  return resolve(resolution.root)
}

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 3000

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
])

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.trim().toLowerCase())

export interface BindConfig {
  readonly host: string
  readonly port: number
  readonly loopback: boolean
}

export const resolveBindConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): BindConfig => {
  const host = env.HOST?.trim() || DEFAULT_HOST
  const rawPort = env.PORT?.trim()
  const port = rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort)

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${rawPort}.`)
  }

  return { host, port, loopback: isLoopbackHost(host) }
}

/**
 * The only warning shown when the unauthenticated local server is exposed to a
 * network interface. Callers print it to stderr before binding.
 */
export const nonLoopbackWarning = (host: string): string =>
  `WARNING: slipmem is binding to non-loopback host ${host}. The HTTP API has no authentication and note files are plaintext; anyone who can reach this address may read or change every note. Bind 127.0.0.1 unless you explicitly accept that risk.`
