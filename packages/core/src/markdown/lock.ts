import { Effect, Semaphore } from "effect"
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
import { MarkdownError, markdownError } from "./errors.js"
import { ensureStateDirectory, STATE_DIRECTORY } from "./root.js"

export const LOCK_FILENAME = "repository.lock"
export const DEFAULT_LOCK_STALE_MS = 30_000

interface LockRecord {
  readonly pid: number
  readonly createdAt: string
  readonly token: string
  /** Linux process start time, used to detect PID reuse after a crash. */
  readonly pidStart?: number
}

interface HeldLock {
  readonly path: string
  readonly token: string
  readonly heartbeat: ReturnType<typeof setInterval> | null
}

// A process cannot rely on an advisory file lock between its own effects: the
// same PID would re-enter. This semaphore serializes writers per repository and
// the lock file is the cross-process signal.
const semaphores = new Map<string, Semaphore.Semaphore>()

const semaphoreFor = (root: string): Semaphore.Semaphore => {
  const key = resolve(root)
  const existing = semaphores.get(key)
  if (existing !== undefined) {
    return existing
  }

  const semaphore = Semaphore.makeUnsafe(1)
  semaphores.set(key, semaphore)
  return semaphore
}

const lockedError = (path: string, message: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "repository-locked",
    path,
    message,
  })

const lockWriteError = (path: string, message: string): MarkdownError =>
  markdownError({
    area: "repository",
    code: "write-failed",
    path,
    message,
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

/**
 * Returns the Linux kernel start time for a process, or null when it is not
 * available. Comparing this value with the record detects the common stale-lock
 * trap where the owner died and an unrelated process later reused its PID.
 */
const processStartTime = (pid: number): number | null => {
  if (process.platform !== "linux") return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const closing = stat.lastIndexOf(")")
    if (closing === -1) return null
    // Fields after the parenthesized command start at field 3 (state).
    // starttime is field 22, i.e. index 19 of this slice.
    const fields = stat.slice(closing + 1).trim().split(/\s+/)
    const raw = fields[19]
    if (raw === undefined) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) ? value : null
  } catch {
    return null
  }
}

const readLock = (path: string): LockRecord | null => {
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      token: parsed.token,
      ...(typeof parsed.pidStart === "number" && Number.isSafeInteger(parsed.pidStart)
        ? { pidStart: parsed.pidStart }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * A lock is stale when its owner is gone, or when the recorded PID has been
 * reused by a different process after the lock stopped being refreshed.
 *
 * A live owner is never evicted solely because the lock is old: a legitimate
 * import can hold the repository for much longer than the stale threshold.
 * The owner refreshes the lock mtime as a heartbeat, so age only matters for
 * dead or reused owners (and for malformed lock files with no readable record).
 */
const lockIsStale = (path: string, staleMs: number): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = lstatSync(path).mtimeMs
  } catch {
    return true
  }

  const record = readLock(path)
  if (record === null) {
    // A fresh malformed lock file is treated as held; it may be mid-write.
    // Only age can recover one left behind by a process that died while
    // creating it.
    return Date.now() - mtimeMs > staleMs
  }

  if (!isProcessAlive(record.pid)) {
    return true
  }

  const currentStart = processStartTime(record.pid)
  if (
    record.pidStart !== undefined &&
    currentStart !== null &&
    currentStart !== record.pidStart
  ) {
    // The PID now belongs to an unrelated process. Only treat it as stale once
    // the recorded owner's heartbeat has lapsed; a fresh lock may still be in
    // the middle of being written.
    return Date.now() - mtimeMs > staleMs
  }

  // The recorded owner is alive and is the same process. Never steal its lock.
  return false
}

const tryCreate = (path: string, record: LockRecord): boolean => {
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

const startHeartbeat = (
  path: string,
  token: string,
  staleMs: number,
): ReturnType<typeof setInterval> => {
  const period = Math.max(25, Math.floor(staleMs / 3))
  const timer = setInterval(() => {
    const current = readLock(path)
    if (current === null || current.token !== token) {
      clearInterval(timer)
      return
    }
    try {
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      // The lock may have been removed by an operator; the next write attempt
      // will surface the real condition.
    }
  }, period)
  timer.unref?.()
  return timer
}

const acquireLockFile = (
  root: string,
  staleMs: number,
): Effect.Effect<HeldLock, MarkdownError> =>
  Effect.gen(function* () {
    let stateDir: string
    try {
      stateDir = ensureStateDirectory(root)
    } catch (cause) {
      return yield* Effect.fail(
        lockWriteError(
          root,
          `Could not create ${STATE_DIRECTORY}/ for the repository lock: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    }

    const path = join(stateDir, LOCK_FILENAME)
    const record: LockRecord = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: randomUUID(),
      ...(() => {
        const pidStart = processStartTime(process.pid)
        return pidStart === null ? {} : { pidStart }
      })(),
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (tryCreate(path, record)) {
          return { path, token: record.token, heartbeat: startHeartbeat(path, record.token, staleMs) }
        }
      } catch (cause) {
        return yield* Effect.fail(
          lockWriteError(
            path,
            `Could not create the repository lock: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        )
      }

      if (!lockIsStale(path, staleMs)) {
        return yield* Effect.fail(
          lockedError(
            path,
            "Another slipmem process is writing to this repository. Retry after it finishes, or remove a stale .state/repository.lock.",
          ),
        )
      }

      try {
        unlinkSync(path)
      } catch {
        // Another process may have removed it first; retry the create once.
      }
    }

    return yield* Effect.fail(
      lockedError(path, "Could not acquire the repository lock after removing a stale lock."),
    )
  })

const releaseLockFile = (lock: HeldLock): Effect.Effect<void> =>
  Effect.sync(() => {
    if (lock.heartbeat !== null) {
      clearInterval(lock.heartbeat)
    }

    const record = readLock(lock.path)
    if (record !== null && record.token !== lock.token) {
      return
    }

    try {
      unlinkSync(lock.path)
    } catch {
      // Already released or removed by an operator.
    }
  })

export interface RepositoryLockOptions {
  readonly staleMs?: number
}

/**
 * Serializes writers in this process and takes the local lock file for other
 * processes. Cross-process writes still rely on atomic create/rename; the lock
 * gives a clear failure instead of a silent last-writer-wins surprise.
 */
export const withRepositoryLock = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  options: RepositoryLockOptions = {},
): Effect.Effect<A, E | MarkdownError, R> =>
  semaphoreFor(root).withPermits(1)(
    Effect.acquireUseRelease(
      acquireLockFile(root, options.staleMs ?? DEFAULT_LOCK_STALE_MS),
      () => effect,
      (lock) => releaseLockFile(lock),
    ),
  )
