import { expect, test } from "bun:test"
import { Duration, Effect, Ref } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initializeNoteRoot } from "../markdown/root.js"
import { MarkdownNoteRepository } from "../markdown/repository.js"
import {
  REVISION_RECEIPT_FILENAME,
  makeServingRuntime,
  type AutomaticMemoryProvider,
  type PrimaryChatModel,
} from "./index.js"

const makeRoot = async (): Promise<{ directory: string; root: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-core-runtime-"))
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  return { directory, root }
}

const waitForFile = (
  path: string,
  timeoutMs = 3_000,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const started = Date.now()
    for (;;) {
      if (existsSync(path)) {
        return
      }
      if (Date.now() - started > timeoutMs) {
        return yield* Effect.fail(
          new Error(`Timed out waiting for ${path}`),
        )
      }
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const fakeChat: PrimaryChatModel = {
  model: "core-runtime-test",
  label: "core-runtime-test",
  egress: "local",
  chat: () => Effect.succeed({ content: "{\"operations\":[]}" }),
}

test("core/runtime owns provider, watcher, receipts, worker, and lifecycle", async () => {
  const { directory, root } = await makeRoot()
  const calls = await Effect.runPromise(Ref.make(0))
  const provider: AutomaticMemoryProvider = {
    maintenance: () =>
      Ref.update(calls, (value) => value + 1).pipe(
        Effect.as({ operations: [] }),
      ),
    chat: fakeChat,
    label: "core-runtime-test",
    egress: "local",
  }

  const runtime = makeServingRuntime({
    root,
    cacheDir: join(directory, "cache"),
    env: {},
    automaticMemory: {
      enabled: true,
      provider,
      watch: false,
    },
  })

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* MarkdownNoteRepository
        yield* repository.create({
          type: "fleeting",
          title: "Core lifecycle wake",
          content: "The core runtime owns this wake.",
        })
        yield* waitForFile(
          join(root, ".state", REVISION_RECEIPT_FILENAME),
        )
      }).pipe(Effect.provide(runtime.services)),
    )

    expect(runtime.automaticMemory.provider).toBe(provider)
    expect(await Effect.runPromise(Ref.get(calls))).toBeGreaterThan(0)

    const receipts = JSON.parse(
      readFileSync(
        join(root, ".state", REVISION_RECEIPT_FILENAME),
        "utf8",
      ),
    ) as { readonly version?: number }
    expect(receipts.version).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
