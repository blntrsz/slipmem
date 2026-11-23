import { expect, test } from "bun:test"
import { Duration, Effect, Exit, Ref } from "effect"
import { existsSync, readFileSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  acquireRunLease,
  DEFAULT_RUN_LEASE_STALE_MS,
  inspectRunLease,
  readRunLease,
  runLeasePath,
  tryAcquireRunLeaseSync,
  withRunLease,
} from "./run-lease.js"

const makeRoot = async (): Promise<{ directory: string; root: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-run-lease-"))
  return { directory, root: join(directory, ".slipmem") }
}

test("the run lease is acquired, visible, and released", async () => {
  const { directory, root } = await makeRoot()
  try {
    const lease = await Effect.runPromise(
      acquireRunLease(root, { staleMs: DEFAULT_RUN_LEASE_STALE_MS }),
    )
    expect(lease.path).toBe(runLeasePath(root))
    expect(existsSync(lease.path)).toBe(true)

    const record = readRunLease(lease.path)
    expect(record).toMatchObject({
      pid: process.pid,
      token: lease.token,
    })
    expect(inspectRunLease(root)).toMatchObject({
      path: lease.path,
      live: true,
      pid: process.pid,
    })

    await Effect.runPromise(lease.release)
    expect(existsSync(lease.path)).toBe(false)
    expect(inspectRunLease(root)).toEqual({
      path: runLeasePath(root),
      live: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the synchronous CLI acquire rejects a live owner and recovers a dead one", async () => {
  const { directory, root } = await makeRoot()
  try {
    const first = tryAcquireRunLeaseSync(root)
    expect(first).not.toBeNull()
    expect(tryAcquireRunLeaseSync(root)).toBeNull()
    first!.releaseUnsafe()
    expect(existsSync(runLeasePath(root))).toBe(false)

    await mkdir(join(root, ".state"), { recursive: true })
    await writeFile(
      runLeasePath(root),
      JSON.stringify({
        pid: 999_999,
        token: "dead",
        createdAt: new Date().toISOString(),
      }),
    )
    expect(inspectRunLease(root).live).toBe(false)

    const recovered = tryAcquireRunLeaseSync(root)
    expect(recovered).not.toBeNull()
    expect(recovered!.token).not.toBe("dead")
    recovered!.releaseUnsafe()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the run lease serializes concurrent consolidators", async () => {
  const { directory, root } = await makeRoot()
  const active = await Effect.runPromise(Ref.make(0))
  const maximum = await Effect.runPromise(Ref.make(0))
  const completed = await Effect.runPromise(Ref.make(0))

  const pass = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(active, (value) => value + 1)
    yield* Ref.update(maximum, (value) => Math.max(value, current))
    yield* Effect.sleep(Duration.millis(25))
    yield* Ref.update(active, (value) => value - 1)
    yield* Ref.update(completed, (value) => value + 1)
  })

  try {
    await Effect.runPromise(
      Effect.all(
        [
          withRunLease(root, pass, { pollMs: 5 }),
          withRunLease(root, pass, { pollMs: 5 }),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(await Effect.runPromise(Ref.get(completed))).toBe(2)
    expect(await Effect.runPromise(Ref.get(maximum))).toBe(1)
    expect(existsSync(runLeasePath(root))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the run lease refuses a symlinked state directory", async () => {
  const { directory, root } = await makeRoot()
  const outside = join(directory, "outside")
  try {
    await mkdir(outside, { recursive: true })
    await mkdir(root, { recursive: true })
    await symlink(outside, join(root, ".state"))

    expect(() => tryAcquireRunLeaseSync(root)).toThrow()

    const exit = await Effect.runPromiseExit(
      withRunLease(root, Effect.void, { pollMs: 5 }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(existsSync(join(outside, "automatic-memory.lease"))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a malformed fresh lease is not stolen before the stale bound", async () => {
  const { directory, root } = await makeRoot()
  try {
    await mkdir(join(root, ".state"), { recursive: true })
    await writeFile(runLeasePath(root), "{not-json")
    expect(inspectRunLease(root, { staleMs: 60_000 }).live).toBe(true)
    expect(tryAcquireRunLeaseSync(root, { staleMs: 60_000 })).toBeNull()

    // An unreadable lease only ages out after the bounded stale window.
    const record = readFileSync(runLeasePath(root), "utf8")
    expect(record).toBe("{not-json")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
