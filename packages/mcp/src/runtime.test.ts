import {
  ApprovalService,
  MarkdownNoteRepository,
  MarkdownSearchIndex,
  PromptRecallService,
  WikiService,
} from "@slipmem/core"
import { expect, test } from "bun:test"
import { Duration, Effect } from "effect"

import { McpApprovalService } from "./approval"
import { RawWriteSignal } from "./automatic-memory"
import { makeServingRegistrationsLayer, makeServingRuntime } from "./runtime"
import {
  makeDisposableRoot,
  makeTestClock,
  removeDisposableRoot,
} from "./test-helpers"

test("the shared serving graph provides one repository, index, and every surface service", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const runtime = makeServingRuntime({
    root: disposable.root,
    cacheDir: disposable.cacheDir,
    now: clock.now,
    env: {},
    automaticMemory: { enabled: false },
  })

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* MarkdownNoteRepository
        const index = yield* MarkdownSearchIndex
        const approval = yield* ApprovalService
        const mcpApproval = yield* McpApprovalService
        const wiki = yield* WikiService
        const recall = yield* PromptRecallService
        const raw = yield* RawWriteSignal

        expect(repository.root).toBe(disposable.root)
        expect(typeof approval.review).toBe("function")
        expect(Object.keys(mcpApproval)).toEqual(["submitMcp"])
        expect(typeof wiki.build).toBe("function")
        expect(typeof recall.recall).toBe("function")

        // A write through the shared repository wakes the same signal the
        // consolidation lifecycle consumes.
        const note = yield* repository.create({
          type: "fleeting",
          title: "Shared wake",
          content: "One graph, one wake queue.",
        })
        yield* raw.awaitSignal.pipe(Effect.timeout(Duration.seconds(1)))

        // The shared index observes the same repository instance.
        yield* index.refresh()
        const hits = yield* index.search({ query: "Shared wake" })
        expect(hits.map((hit) => String(hit.note.id))).toEqual([
          String(note.id),
        ])
      }).pipe(Effect.provide(runtime.services)),
    )
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("the standalone registration helper still requires the serving chat model", async () => {
  const disposable = await makeDisposableRoot()
  try {
    expect(() =>
      makeServingRegistrationsLayer({
        root: disposable.root,
        env: {},
      }),
    ).toThrow("SLIPMEM_CHAT_MODEL")
  } finally {
    await removeDisposableRoot(disposable)
  }
})
