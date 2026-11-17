import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
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
}

interface HeldLock {
  readonly path: string
  readonly token: string
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
    }
  } catch {
    return null
  }
}

const lockIsStale = (path: string, staleMs: number): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = lstatSync(path).mtimeMs
  } catch {
    return true
  }

  if (Date.now() - mtimeMs > staleMs) {
    return true
  }

  const record = readLock(path)
  // A malformed lock file that is still fresh is treated as held; an operator
  // can remove it after inspecting the path. Waiting forever would hang tools.
  return record !== null && !isProcessAlive(record.pid)
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
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (tryCreate(path, record)) {
          return { path, token: record.token }
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
