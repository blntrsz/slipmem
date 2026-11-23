import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MarkdownError } from "./errors.js"
import { withRepositoryLock } from "./lock.js"

const temporaryRoot = (): string => mkdtempSync(join(tmpdir(), "slipmem-lock-"))

const cleanup = (path: string): void => {
  rmSync(path, { recursive: true, force: true })
}

const lockPathFor = (root: string): string =>
  join(root, ".state", "repository.lock")

const writeLock = (
  root: string,
  record: Readonly<Record<string, unknown>>,
): string => {
  mkdirSync(join(root, ".state"), { recursive: true })
  const path = lockPathFor(root)
  writeFileSync(path, JSON.stringify(record))
  return path
}

const ageFile = (path: string, milliseconds: number): void => {
  const old = new Date(Date.now() - milliseconds)
  utimesSync(path, old, old)
}

const failureCode = async (
  effect: Effect.Effect<unknown, MarkdownError>,
): Promise<string> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected the lock acquisition to fail")
  }
  const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (fail === undefined || fail._tag !== "Fail") {
    throw new Error("Expected a typed failure")
  }
  return fail.error.code
}

describe("repository lock staleness", () => {
  test("never steals an aged lock whose live owner PID still matches", async () => {
    const root = temporaryRoot()
    try {
      const path = writeLock(root, {
        pid: process.pid,
        createdAt: "2026-01-01T00:00:00.000Z",
        token: "live-owner",
      })
      ageFile(path, 3_600_000)

      const code = await failureCode(
        withRepositoryLock(root, Effect.succeed("stolen"), { staleMs: 10 }),
      )

      expect(code).toBe("repository-locked")
      expect(readFileSync(path, "utf8")).toContain("live-owner")
    } finally {
      cleanup(root)
    }
  })

  test("refreshes the lock heartbeat while a long effect runs", async () => {
    const root = temporaryRoot()
    try {
      const path = lockPathFor(root)
      const startedAt = Date.now()
      const observed = await Effect.runPromise(
        withRepositoryLock(
          root,
          Effect.gen(function* () {
            yield* Effect.sleep("180 millis")
            expect(lstatSync(path).isFile()).toBe(true)
            return lstatSync(path).mtimeMs
          }),
          { staleMs: 60 },
        ),
      )

      // Without a heartbeat the lock would still carry its creation mtime,
      // which is already older than staleMs at this point.
      expect(observed).toBeGreaterThan(startedAt + 100)
    } finally {
      cleanup(root)
    }
  })

  test("recovers a stale lock whose owner process is gone", async () => {
    const root = temporaryRoot()
    try {
      const path = writeLock(root, {
        pid: 2_147_483_647,
        createdAt: "2026-01-01T00:00:00.000Z",
        token: "dead-owner",
      })
      ageFile(path, 120_000)

      const result = await Effect.runPromise(
        withRepositoryLock(root, Effect.succeed("recovered"), { staleMs: 10 }),
      )

      expect(result).toBe("recovered")
      expect(existsSync(path)).toBe(false)
    } finally {
      cleanup(root)
    }
  })

  test("treats a live PID with a different process start time as reused", async () => {
    const root = temporaryRoot()
    try {
      const path = writeLock(root, {
        pid: process.pid,
        createdAt: "2026-01-01T00:00:00.000Z",
        token: "reused-pid",
        // This process is alive, but its recorded start time cannot match the
        // real one, so the record belongs to a process that has already died.
        pidStart: -1,
      })
      ageFile(path, 120_000)

      const result = await Effect.runPromise(
        withRepositoryLock(root, Effect.succeed("recovered"), { staleMs: 10 }),
      )

      expect(result).toBe("recovered")
      expect(existsSync(path)).toBe(false)
    } finally {
      cleanup(root)
    }
  })
})
