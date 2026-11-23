import { randomUUID } from "node:crypto"
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { Duration, Effect } from "effect"

import { ensureStateDirectory, STATE_DIRECTORY } from "../markdown/root.js"

/**
 * The cross-process consolidation lease shared by every serving runtime and
 * the CLI's one-shot `--consolidate` path.
 *
 * It is deliberately not the repository mutation lock. A consolidator holds
 * this lease across a provider call; each repository write still takes the
 * authoritative mutation lock for its own critical section.
 */
export const RUN_LEASE_FILENAME = "automatic-memory.lease"
export const DEFAULT_RUN_LEASE_STALE_MS = 10 * 60_000
export const DEFAULT_RUN_LEASE_POLL_MS = 250

export interface RunLeaseOptions {
  readonly staleMs?: number
  readonly pollMs?: number
  /** Injectable clock for the lease record; the heartbeat uses real time. */
  readonly now?: () => number
}

export interface RunLeaseRecord {
  readonly pid: number
  readonly token: string
  readonly createdAt: string
}

export interface RunLeaseStatus {
  readonly path: string
  readonly live: boolean
  readonly pid?: number
  readonly record?: RunLeaseRecord
}

export interface HeldRunLease {
  readonly path: string
  readonly token: string
  /** Releases the lease and stops the heartbeat. Safe to call twice. */
  readonly release: Effect.Effect<void>
  /** Synchronous release for CLI code that does not run inside Effect. */
  readonly releaseUnsafe: () => void
}

const leasePath = (root: string): string =>
  join(resolve(root), STATE_DIRECTORY, RUN_LEASE_FILENAME)

/** The exact lease path for a note root. */
export const runLeasePath = (root: string): string => leasePath(root)

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const ensureLeaseStateDirectorySync = (root: string): void => {
  try {
    ensureStateDirectory(root)
  } catch (cause) {
    throw new Error(
      `Could not create ${STATE_DIRECTORY}/ for the run lease: ${messageOf(cause)}`,
    )
  }
}

const ensureLeaseStateDirectory = (root: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => ensureLeaseStateDirectorySync(root),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Could not create ${STATE_DIRECTORY}/ for the run lease.`),
  })

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EPERM"
    )
  }
}

/** Reads a lease record without repairing or acquiring it. */
export const readRunLease = (path: string): RunLeaseRecord | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunLeaseRecord>
    return typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.createdAt === "string"
      ? {
          pid: parsed.pid,
          token: parsed.token,
          createdAt: parsed.createdAt,
        }
      : null
  } catch {
    return null
  }
}

const leaseIsStale = (path: string, staleMs: number): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = lstatSync(path).mtimeMs
  } catch {
    return true
  }
  const record = readRunLease(path)
  if (record === null) {
    // A fresh malformed file may be mid-write; only age recovers it.
    return Date.now() - mtimeMs > staleMs
  }
  if (!isProcessAlive(record.pid)) {
    return true
  }
  // A live owner with a lapsed heartbeat is treated as stale only after the
  // bounded lease age. The owner refreshes the mtime while the provider runs.
  return Date.now() - mtimeMs > staleMs
}

const tryCreateLease = (path: string, record: RunLeaseRecord): boolean => {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeSync(descriptor, JSON.stringify(record))
    return true
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EEXIST"
    ) {
      return false
    }
    throw cause
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // Another waiter may have removed it first.
  }
}

const makeLeaseRecord = (options: RunLeaseOptions): RunLeaseRecord => ({
  pid: process.pid,
  token: randomUUID(),
  createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
})

const startHeartbeat = (
  path: string,
  token: string,
  staleMs: number,
): HeldRunLease => {
  const heartbeat = setInterval(() => {
    const current = readRunLease(path)
    if (current === null || current.token !== token) {
      clearInterval(heartbeat)
      return
    }
    try {
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      // The next acquire/release observes the real condition.
    }
  }, Math.max(25, Math.floor(staleMs / 3)))
  heartbeat.unref?.()

  const releaseUnsafe = (): void => {
    clearInterval(heartbeat)
    const current = readRunLease(path)
    if (current !== null && current.token !== token) {
      return
    }
    unlinkIfPresent(path)
  }

  return {
    path,
    token,
    release: Effect.sync(releaseUnsafe),
    releaseUnsafe,
  }
}

/**
 * Acquires the lease, waiting for a live owner to release it. A dead owner or
 * an aged-out lease is recovered. The wait never drops a wake: once the holder
 * releases, the caller runs and re-checks durable receipts.
 */
export const acquireRunLease = (
  root: string,
  options: RunLeaseOptions = {},
): Effect.Effect<HeldRunLease, Error> =>
  Effect.gen(function* () {
    yield* ensureLeaseStateDirectory(root)
    const path = leasePath(root)
    const staleMs = options.staleMs ?? DEFAULT_RUN_LEASE_STALE_MS
    const pollMs = options.pollMs ?? DEFAULT_RUN_LEASE_POLL_MS
    const record = makeLeaseRecord(options)

    for (;;) {
      const created = yield* Effect.try({
        try: () => tryCreateLease(path, record),
        catch: (cause) =>
          new Error(
            `Could not acquire the run lease: ${messageOf(cause)}`,
          ),
      })
      if (created) {
        return startHeartbeat(path, record.token, staleMs)
      }

      const stale = yield* Effect.sync(() => leaseIsStale(path, staleMs))
      if (stale) {
        yield* Effect.sync(() => unlinkIfPresent(path))
        continue
      }

      yield* Effect.sleep(Duration.millis(pollMs))
    }
  })

/**
 * Acquires the lease without waiting. Returns `null` when a live owner exists.
 * Used by the CLI's `--consolidate` path, which rejects rather than queues.
 */
export const tryAcquireRunLeaseSync = (
  root: string,
  options: RunLeaseOptions = {},
): HeldRunLease | null => {
  ensureLeaseStateDirectorySync(root)
  const path = leasePath(root)
  const staleMs = options.staleMs ?? DEFAULT_RUN_LEASE_STALE_MS
  const record = makeLeaseRecord(options)

  for (;;) {
    if (tryCreateLease(path, record)) {
      return startHeartbeat(path, record.token, staleMs)
    }
    if (!leaseIsStale(path, staleMs)) {
      return null
    }
    unlinkIfPresent(path)
  }
}

/** Releases a held lease without throwing. Safe to call twice. */
export const releaseRunLease = (lease: HeldRunLease): Effect.Effect<void> =>
  Effect.sync(() => lease.releaseUnsafe())

/**
 * Reads the lease and reports whether a live owner currently holds it. It
 * never creates, repairs, or deletes the lease.
 */
export const inspectRunLease = (
  root: string,
  options: Pick<RunLeaseOptions, "staleMs"> = {},
): RunLeaseStatus => {
  const path = leasePath(root)
  let present = true
  try {
    lstatSync(path)
  } catch {
    present = false
  }
  if (!present) {
    return { path, live: false }
  }
  const record = readRunLease(path)
  const live = !leaseIsStale(
    path,
    options.staleMs ?? DEFAULT_RUN_LEASE_STALE_MS,
  )
  return {
    path,
    live,
    ...(record === null ? {} : { pid: record.pid, record }),
  }
}

/**
 * Serializes consolidation across processes without holding the repository
 * mutation lock. The provider call runs under this lease only.
 */
export const withRunLease = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  options: RunLeaseOptions = {},
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    acquireRunLease(root, options),
    () => effect,
    releaseRunLease,
  )
