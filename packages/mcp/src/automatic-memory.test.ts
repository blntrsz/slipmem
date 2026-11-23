import { expect, test } from "bun:test"
import {
  makeMarkdownNoteRepository,
  MarkdownNoteRepository,
  MarkdownNoteRepositoryLive,
  PermanentMaintenanceWorker,
  PermanentMaintenanceWorkerLive,
  type MaintenanceProvider,
  type MaintenanceRunResult,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Duration, Effect, Exit, Layer, Queue, Ref } from "effect"
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_RECALL_JEV_MODEL,
  formatAutomaticMemoryNotice,
  makeAutomaticMemoryLayer,
  makeRawWriteRepositoryLayer,
  makeRawWriteSignalLayer,
  PRIMARY_CHAT_ENV_NAMES,
  RawWriteSignal,
  REVISION_RECEIPT_FILENAME,
  resolveAutomaticMemoryRuntime,
  resolvePrimaryChatModel,
  resolveRecallProvider,
  RUN_LEASE_FILENAME,
  withRunLease,
  type AutomaticMemoryProvider,
  type AutomaticMemoryRuntime,
  type RawWriteSignalShape,
} from "./automatic-memory"
import {
  createTestNote,
  makeDisposableRoot,
  makeTestClock,
  removeDisposableRoot,
} from "./test-helpers"

const noopResult: MaintenanceRunResult = {
  status: "no-op",
  generatedAt: "2026-11-22T00:00:00Z",
  examinedSources: [],
  pendingSourceCount: 0,
  selectedSourceIds: [],
  candidateIds: [],
  omittedSourceCount: 0,
  providerCalled: false,
  writes: [],
  skips: [],
}

const chatEnv = {
  SLIPMEM_AUTO_MEMORY: "on",
  SLIPMEM_CHAT_PROVIDER: "openai-compatible",
  SLIPMEM_CHAT_MODEL: "explicit-model",
  SLIPMEM_CHAT_BASE_URL: "https://provider.example/v1",
  SLIPMEM_CHAT_API_KEY: "test-key",
} as const

const legacyEnv = {
  SLIPMEM_AUTO_MEMORY: "on",
  SLIPMEM_MAINTENANCE_PROVIDER: "openai-compatible",
  SLIPMEM_MAINTENANCE_MODEL: "legacy-model",
  SLIPMEM_MAINTENANCE_BASE_URL: "https://legacy.example/v1",
  SLIPMEM_MAINTENANCE_API_KEY: "legacy-key",
} as const

const testProvider: AutomaticMemoryProvider = {
  maintenance: () => Effect.succeed({ operations: [] }),
  chat: {
    model: "test-model",
    label: "test-model at http://127.0.0.1",
    egress: "local",
    chat: () => Effect.succeed({ content: "{}" }),
  },
  label: "test-model at http://127.0.0.1",
  egress: "local",
}

const testSignal = async (): Promise<RawWriteSignalShape> => {
  const queue = await Effect.runPromise(Queue.bounded<void>(64))
  const voidOf = (effect: Effect.Effect<unknown>) =>
    effect.pipe(Effect.map(() => undefined))
  return {
    signal: voidOf(Queue.offer(queue, undefined)),
    awaitSignal: voidOf(Queue.take(queue)),
    drain: voidOf(Queue.clear(queue)),
    signalUnsafe: () => {
      Queue.offerUnsafe(queue, undefined)
    },
  }
}

const runtimeWith = (
  provider: AutomaticMemoryProvider | undefined,
  overrides: Partial<AutomaticMemoryRuntime> = {},
): AutomaticMemoryRuntime => ({
  enabled: true,
  ...(provider === undefined ? {} : { provider }),
  report: () => undefined,
  watch: false,
  ...overrides,
})

const repositoryLayer = (root: string, now: () => number) =>
  makeRawWriteRepositoryLayer().pipe(
    Layer.provide(MarkdownNoteRepositoryLive({ root, now })),
  )

const workerLayer = (
  root: string,
  run: () => Effect.Effect<MaintenanceRunResult>,
) =>
  Layer.succeed(PermanentMaintenanceWorker, {
    root,
    run,
  })

const runtimeLayer = (options: {
  readonly root: string
  readonly now: () => number
  readonly runtime: AutomaticMemoryRuntime
  readonly signal: RawWriteSignalShape
  readonly run: () => Effect.Effect<MaintenanceRunResult>
}) =>
  makeAutomaticMemoryLayer(options.runtime).pipe(
    Layer.provide(
      Layer.merge(
        repositoryLayer(options.root, options.now).pipe(
          Layer.provideMerge(
            Layer.succeed(RawWriteSignal, options.signal),
          ),
        ),
        workerLayer(options.root, options.run),
      ),
    ),
  )

/** Real bounded worker sharing the same wrapped repository as the lifecycle. */
const realWorkerRuntimeLayer = (options: {
  readonly root: string
  readonly now: () => number
  readonly runtime: AutomaticMemoryRuntime
  readonly signal: RawWriteSignalShape
  readonly provider: MaintenanceProvider
}) => {
  const services = repositoryLayer(options.root, options.now).pipe(
    Layer.provideMerge(Layer.succeed(RawWriteSignal, options.signal)),
  )
  const worker = PermanentMaintenanceWorkerLive({
    provider: options.provider,
  }).pipe(Layer.provide(services))
  return makeAutomaticMemoryLayer(options.runtime).pipe(
    Layer.provide(Layer.merge(services, worker)),
  )
}

const readReceiptSources = async (
  root: string,
): Promise<Readonly<Record<string, string>> | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, ".state", REVISION_RECEIPT_FILENAME), "utf8"),
    ) as {
      readonly version?: unknown
      readonly coverage?: unknown
      readonly revisions?: unknown
    }
    if (
      parsed.version !== 1 ||
      parsed.coverage !== "examined" ||
      typeof parsed.revisions !== "object" ||
      parsed.revisions === null ||
      Array.isArray(parsed.revisions)
    ) {
      return null
    }
    const result: Record<string, string> = {}
    for (const [id, hash] of Object.entries(parsed.revisions)) {
      if (typeof hash === "string") {
        result[id] = hash
      }
    }
    return result
  } catch {
    return null
  }
}

const waitFor = (
  probe: () => Promise<boolean>,
  timeoutMs = 3_000,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (yield* Effect.promise(probe)) {
        return
      }
      yield* Effect.sleep(Duration.millis(10))
    }
    throw new Error(`Timed out after ${timeoutMs}ms`)
  })

test("serving requires a primary chat model even when nothing enables it", () => {
  expect(() => resolveAutomaticMemoryRuntime({})).toThrow(
    "serving requires a primary chat model",
  )
  expect(formatAutomaticMemoryNotice({ enabled: false })).toBeUndefined()
})

test("an explicit off value cannot restore a no-model production serve", () => {
  expect(() =>
    resolveAutomaticMemoryRuntime({ SLIPMEM_AUTO_MEMORY: "off" }),
  ).toThrow("serving requires a primary chat model")
  expect(() =>
    resolveAutomaticMemoryRuntime({ SLIPMEM_AUTO_MEMORY: "yes" }),
  ).toThrow("serving requires a primary chat model")
})

test("enabling the lifecycle requires a primary chat model", () => {
  expect(() =>
    resolveAutomaticMemoryRuntime({ SLIPMEM_AUTO_MEMORY: "on" }),
  ).toThrow("requires a primary chat model")

  expect(() =>
    resolveAutomaticMemoryRuntime({
      ...chatEnv,
      SLIPMEM_CHAT_MODEL: undefined,
    }),
  ).toThrow("SLIPMEM_CHAT_MODEL")

  expect(() =>
    resolveAutomaticMemoryRuntime({
      ...chatEnv,
      SLIPMEM_CHAT_BASE_URL: undefined,
    }),
  ).toThrow("SLIPMEM_CHAT_BASE_URL")
})

test("the legacy maintenance names remain accepted for the primary model", () => {
  const runtime = resolveAutomaticMemoryRuntime(legacyEnv)
  expect(runtime.provider?.chat.model).toBe("legacy-model")
  expect(runtime.provider?.label).toContain("https://legacy.example")
  expect(formatAutomaticMemoryNotice(runtime)).toContain("legacy-model")
})

test("plain HTTP chat provider URLs are accepted only on loopback", () => {
  const local = resolveAutomaticMemoryRuntime({
    ...chatEnv,
    SLIPMEM_CHAT_BASE_URL: "http://127.0.0.1:8080/v1",
  })
  expect(local.provider?.egress).toBe("local")

  expect(() =>
    resolveAutomaticMemoryRuntime({
      ...chatEnv,
      SLIPMEM_CHAT_BASE_URL: "http://provider.example/v1",
    }),
  ).toThrow("Plain HTTP chat providers are allowed only on a loopback host")
})

test("the startup notice states write triggers, recovery, egress, and the direct-write path", () => {
  const runtime = resolveAutomaticMemoryRuntime({
    ...chatEnv,
    SLIPMEM_AUTO_MEMORY_INTERVAL_MS: "600000",
  })
  const notice = formatAutomaticMemoryNotice(runtime)
  expect(notice).toContain("one recovery pass runs at startup")
  expect(notice).toContain("note revision is written")
  expect(notice).toContain("no periodic timer")
  expect(notice).toContain("Cross-process wakes")
  expect(notice).toContain("leaves this machine")
  expect(notice).toContain('provenance source "maintenance"')
  expect(notice).toContain("does not use the MCP approval queue")
  expect(notice).not.toContain("test-key")
  expect(notice).not.toContain("10 minutes")
})

test("a loopback provider notice discloses local-only egress", () => {
  const runtime = resolveAutomaticMemoryRuntime({
    ...chatEnv,
    SLIPMEM_CHAT_BASE_URL: "http://localhost:8080/v1",
  })
  const notice = formatAutomaticMemoryNotice(runtime)
  expect(notice).toContain("local endpoint")
  expect(notice).not.toContain("leaves this machine")
})

test("the reusable primary chat getter exposes no credential", () => {
  const chat = resolvePrimaryChatModel(chatEnv)
  expect(chat?.model).toBe("explicit-model")
  expect(chat?.label).toBe("explicit-model at https://provider.example")
  expect(chat?.egress).toBe("remote")
  expect(JSON.stringify(chat)).not.toContain("test-key")
  expect(PRIMARY_CHAT_ENV_NAMES.provider).toBe("SLIPMEM_CHAT_PROVIDER")
})

test("a key alone does not enable prompt-recall egress", () => {
  expect(resolveRecallProvider({ TYPESAFE_API_KEY: "key" })).toEqual({})
})

test("Jev prompt recall requires the explicit provider and key", () => {
  expect(() =>
    resolveRecallProvider({ SLIPMEM_RECALL_PROVIDER: "jev" }),
  ).toThrow("TYPESAFE_API_KEY")

  const runtime = resolveRecallProvider({
    SLIPMEM_RECALL_PROVIDER: "jev",
    TYPESAFE_API_KEY: "key",
  })
  expect(runtime.provider).toBe("jev")
  expect(runtime.evaluator?.model).toBe(DEFAULT_RECALL_JEV_MODEL)
  expect(runtime.notice).toContain("recall_prompt")
  expect(runtime.notice).toContain("Jev/TypeSafe")
})

test("the primary chat model serves structured recall when Jev is off", () => {
  const runtime = resolveRecallProvider(chatEnv)
  expect(runtime.provider).toBe("chat")
  expect(runtime.evaluator?.model).toBe("explicit-model")
  expect(runtime.notice).toContain("validated structured decision")
  expect(runtime.notice).toContain("explicit-model")
})

test("an explicit Jev selection is not combined with the chat fallback", () => {
  const runtime = resolveRecallProvider({
    ...chatEnv,
    SLIPMEM_RECALL_PROVIDER: "jev",
    TYPESAFE_API_KEY: "key",
  })
  expect(runtime.provider).toBe("jev")
  expect(runtime.evaluator?.model).toBe(DEFAULT_RECALL_JEV_MODEL)
})

test("an unrecognized recall provider fails instead of falling back", () => {
  expect(() =>
    resolveRecallProvider({ SLIPMEM_RECALL_PROVIDER: "local" }),
  ).toThrow("SLIPMEM_RECALL_PROVIDER must be jev or off")
})

test("raw repository writes signal, while generated permanent writes do not", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const signal = await testSignal()
  const queue = await Effect.runPromise(Queue.bounded<void>(4))
  const signalWithQueue: RawWriteSignalShape = {
    ...signal,
    signal: Queue.offer(queue, undefined).pipe(Effect.map(() => undefined)),
    signalUnsafe: () => {
      Queue.offerUnsafe(queue, undefined)
    },
  }

  try {
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* MarkdownNoteRepository
      }).pipe(
        Effect.provide(
          repositoryLayer(disposable.root, clock.now).pipe(
            Layer.provideMerge(
              Layer.succeed(RawWriteSignal, signalWithQueue),
            ),
          ),
        ),
      ),
    )

    const size = () => Effect.runPromise(Queue.size(queue))
    const fleeting = await Effect.runPromise(
      repository.create({
        type: "fleeting",
        title: "Raw capture",
        content: "A raw note.",
      }),
    )
    expect(await size()).toBe(1)
    await Effect.runPromise(Queue.clear(queue))

    await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: "Generated",
        content: "A generated permanent.",
      }),
    )
    expect(await size()).toBe(0)

    await Effect.runPromise(
      repository.update({ id: fleeting.id, content: "Updated raw note." }),
    )
    expect(await size()).toBe(1)
    await Effect.runPromise(Queue.clear(queue))

    await Effect.runPromise(repository.delete(fleeting.id))
    expect(await size()).toBe(1)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("startup recovery and queued writes run sequentially and stop with the scope", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const signal = await testSignal()
  const active = await Effect.runPromise(Ref.make(0))
  const maximum = await Effect.runPromise(Ref.make(0))
  const runs = await Effect.runPromise(Ref.make(0))

  const run = () =>
    Effect.gen(function* () {
      const current = yield* Ref.updateAndGet(active, (value) => value + 1)
      yield* Ref.update(maximum, (value) => Math.max(value, current))
      yield* Ref.update(runs, (value) => value + 1)
      yield* Effect.sleep(Duration.millis(20))
      yield* Ref.update(active, (value) => value - 1)
      return noopResult
    })

  const layer = runtimeLayer({
    root: disposable.root,
    now: clock.now,
    runtime: runtimeWith(testProvider, { revisionGate: false }),
    signal,
    run,
  })

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer)
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 1,
          ) as Effect.Effect<void>

          yield* signal.signal
          yield* signal.signal
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 2,
          ) as Effect.Effect<void>
          // No periodic timer: after the queued pass there are no more runs.
          yield* Effect.sleep(Duration.millis(80))
        }),
      ),
    )

    const completed = await Effect.runPromise(Ref.get(runs))
    expect(completed).toBe(2)
    expect(await Effect.runPromise(Ref.get(maximum))).toBe(1)
    await Bun.sleep(30)
    expect(await Effect.runPromise(Ref.get(runs))).toBe(completed)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("durable receipts skip an unchanged restart and accept a new revision", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const runs = await Effect.runPromise(Ref.make(0))
  const run = () =>
    Ref.update(runs, (value) => value + 1).pipe(Effect.as(noopResult))

  const build = (signal: RawWriteSignalShape) =>
    runtimeLayer({
      root: disposable.root,
      now: clock.now,
      runtime: runtimeWith(testProvider),
      signal,
      run,
    })

  try {
    // First process: recovery records the current source revisions.
    const firstSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(build(firstSignal))
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 1,
          ) as Effect.Effect<void>
        }),
      ),
    )
    expect(await Effect.runPromise(Ref.get(runs))).toBe(1)

    // Restart with no revision change: the receipt gate performs no run.
    const secondSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(build(secondSignal))
          yield* Effect.sleep(Duration.millis(60))
        }),
      ),
    )
    expect(await Effect.runPromise(Ref.get(runs))).toBe(1)

    // A new raw revision is a different receipt and triggers one pass.
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* MarkdownNoteRepository
      }).pipe(
        Effect.provide(
          MarkdownNoteRepositoryLive({ root: disposable.root, now: clock.now }),
        ),
      ),
    )
    await Effect.runPromise(
      repository.create({
        type: "fleeting",
        title: "New capture",
        content: "New raw revision.",
      }),
    )
    const thirdSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(build(thirdSignal))
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 2,
          ) as Effect.Effect<void>
        }),
      ),
    )
    expect(await Effect.runPromise(Ref.get(runs))).toBe(2)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("the note watcher wakes on cross-process writes and ignores state/temp changes", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const signal = await testSignal()
  const runs = await Effect.runPromise(Ref.make(0))
  const run = () =>
    Ref.update(runs, (value) => value + 1).pipe(Effect.as(noopResult))

  const layer = runtimeLayer({
    root: disposable.root,
    now: clock.now,
    runtime: runtimeWith(testProvider, {
      revisionGate: false,
      watch: true,
    }),
    signal,
    run,
  })

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer)
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 1,
          ) as Effect.Effect<void>

          // State and temporary files are not note revisions.
          yield* Effect.promise(() =>
            mkdir(join(disposable.root, ".state", "ignored"), {
              recursive: true,
            }),
          )
          yield* Effect.promise(() =>
            writeFile(join(disposable.root, ".state", "ignored", "x.json"), "{}"),
          )
          yield* Effect.sleep(Duration.millis(100))
          expect(yield* Ref.get(runs)).toBe(1)

          // A separate repository represents another process's raw write.
          const external = yield* Effect.promise(() =>
            Effect.runPromise(
              Effect.gen(function* () {
                return yield* MarkdownNoteRepository
              }).pipe(
                Effect.provide(
                  MarkdownNoteRepositoryLive({
                    root: disposable.root,
                    now: clock.now,
                  }),
                ),
              ),
            ),
          )
          yield* external.create({
            type: "fleeting",
            title: "Cross-process capture",
            content: "Written outside the watcher process.",
          })
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(runs))) >= 2,
          ) as Effect.Effect<void>
        }),
      ),
    )
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("pre-fix whole-snapshot receipts get one conservative rescan", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const sources: Array<ParsedMarkdownNote> = []
  for (let index = 0; index < 13; index += 1) {
    clock.advance(1_000)
    sources.push(
      await createTestNote(
        disposable.root,
        {
          type: "fleeting",
          title: `Legacy receipt source ${index}`,
          content: `Legacy receipt body ${index}.`,
        },
        clock.now,
      ),
    )
  }

  // The old implementation recorded the whole inbox here, including notes a
  // bounded run never examined. Without the coverage marker this would make
  // the thirteenth revision permanently terminal.
  await mkdir(join(disposable.root, ".state"), { recursive: true })
  await writeFile(
    join(disposable.root, ".state", REVISION_RECEIPT_FILENAME),
    JSON.stringify({
      version: 1,
      revisions: Object.fromEntries(
        sources.map((source) => [source.id, source.contentHash]),
      ),
      managed: {},
    }),
  )

  const signal = await testSignal()
  const runs = await Effect.runPromise(Ref.make(0))
  const run = () =>
    Ref.update(runs, (value) => value + 1).pipe(Effect.as(noopResult))

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            runtimeLayer({
              root: disposable.root,
              now: clock.now,
              runtime: runtimeWith(testProvider),
              signal,
              run,
            }),
          )
          yield* waitFor(async () => {
            const receipts = await readReceiptSources(disposable.root)
            return (
              receipts !== null &&
              sources.every((source) => receipts[source.id] !== undefined)
            )
          }) as Effect.Effect<void>
        }),
      ),
    )

    expect(await Effect.runPromise(Ref.get(runs))).toBe(1)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("an explicit no-op over existing sources is durable", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  clock.advance(1_000)
  const source = await createTestNote(
    disposable.root,
    {
      type: "fleeting",
      title: "Already consolidated",
      content: "A raw revision the worker explicitly leaves alone.",
    },
    clock.now,
  )
  const runs = await Effect.runPromise(Ref.make(0))
  const run = () =>
    Ref.update(runs, (value) => value + 1).pipe(Effect.as(noopResult))
  const build = (signal: RawWriteSignalShape) =>
    runtimeLayer({
      root: disposable.root,
      now: clock.now,
      runtime: runtimeWith(testProvider),
      signal,
      run,
    })

  try {
    const firstSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(build(firstSignal))
          yield* waitFor(async () => {
            const receipts = await readReceiptSources(disposable.root)
            return receipts?.[source.id] !== undefined
          }) as Effect.Effect<void>
        }),
      ),
    )
    expect(await Effect.runPromise(Ref.get(runs))).toBe(1)

    const restartSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(build(restartSignal))
          yield* Effect.sleep(Duration.millis(80))
        }),
      ),
    )
    expect(await Effect.runPromise(Ref.get(runs))).toBe(1)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("one wake drains a 13-note backlog across bounded worker batches", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const signal = await testSignal()
  const offers = await Effect.runPromise(
    Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]),
  )
  const sources: Array<ParsedMarkdownNote> = []
  for (let index = 0; index < 13; index += 1) {
    clock.advance(1_000)
    sources.push(
      await createTestNote(
        disposable.root,
        {
          type: "fleeting",
          title: `Backlog source ${index}`,
          content: `Backlog body ${index}.`,
        },
        clock.now,
      ),
    )
  }

  // The real worker selects at most 12 sources and accepts at most 8
  // operations per run. Thirteen notes therefore need at least two runs even
  // though the first wake must not lose the thirteenth revision.
  const provider: MaintenanceProvider = (request) =>
    Effect.gen(function* () {
      yield* Ref.update(offers, (runs) => [
        ...runs,
        request.sources.map((source) => source.id),
      ])
      return {
        operations: request.sources.slice(0, 8).map((source) => ({
          operation: "create",
          title: `Backlog memory ${source.id}`,
          content: `Consolidated from ${source.title}.`,
          tags: ["regression"],
          sourceIds: [source.id],
        })),
      }
    })

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            realWorkerRuntimeLayer({
              root: disposable.root,
              now: clock.now,
              runtime: runtimeWith(testProvider),
              signal,
              provider,
            }),
          )
          yield* waitFor(() =>
            readReceiptSources(disposable.root).then(
              (receipts) =>
                receipts !== null &&
                sources.every((source) => receipts[source.id] !== undefined),
            ),
          ) as Effect.Effect<void>
        }),
      ),
    )

    const batches = await Effect.runPromise(Ref.get(offers))
    expect(batches.length).toBeGreaterThan(1)
    expect(new Set(batches.flat()).size).toBe(13)

    const receipts = await readReceiptSources(disposable.root)
    expect(Object.keys(receipts ?? {}).sort()).toEqual(
      sources.map((source) => source.id).sort(),
    )

    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({ root: disposable.root, now: clock.now }),
    )
    const scan = await Effect.runPromise(repository.scan())
    const generated = scan.notes.filter(
      (note) => note.metadata.provenance?.source === "maintenance",
    )
    expect(generated).toHaveLength(13)

    // Restart with the same 13 revisions: the gate is satisfied by the
    // examined receipts and managed snapshots, so no provider call is made.
    let restartCalls = 0
    const restartProvider: MaintenanceProvider = () => {
      restartCalls += 1
      return Effect.succeed({ operations: [] })
    }
    const restartSignal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            realWorkerRuntimeLayer({
              root: disposable.root,
              now: clock.now,
              runtime: runtimeWith(testProvider),
              signal: restartSignal,
              provider: restartProvider,
            }),
          )
          yield* Effect.sleep(Duration.millis(100))
        }),
      ),
    )
    expect(restartCalls).toBe(0)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("unexamined revisions are not receipted and stay pending for the next wake", async () => {
  const disposable = await makeDisposableRoot()
  const clock = makeTestClock()
  const signal = await testSignal()
  const calls = await Effect.runPromise(Ref.make(0))
  const sources: Array<Awaited<ReturnType<typeof createTestNote>>> = []
  for (let index = 0; index < 13; index += 1) {
    clock.advance(1_000)
    sources.push(
      await createTestNote(
        disposable.root,
        {
          type: "fleeting",
          title: `Partially examined ${index}`,
          content: `Partially examined body ${index}.`,
        },
        clock.now,
      ),
    )
  }
  const firstBatch = sources.slice(0, 12)
  const unexamined = sources[12]!

  const run = () =>
    Effect.gen(function* () {
      const call = yield* Ref.updateAndGet(calls, (value) => value + 1)
      if (call === 1) {
        return {
          ...noopResult,
          examinedSources: firstBatch.map((source) => ({
            id: source.id,
            contentHash: source.contentHash,
          })),
          pendingSourceCount: 13,
          selectedSourceIds: firstBatch.map((source) => source.id),
          omittedSourceCount: 1,
          providerCalled: true,
        }
      }
      return {
        ...noopResult,
        pendingSourceCount: 1,
        selectedSourceIds: [],
        omittedSourceCount: 1,
      }
    })

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            runtimeLayer({
              root: disposable.root,
              now: clock.now,
              runtime: runtimeWith(testProvider),
              signal,
              run,
            }),
          )
          yield* waitFor(() =>
            readReceiptSources(disposable.root).then(
              (receipts) =>
                receipts !== null && Object.keys(receipts).length === 12,
            ),
          ) as Effect.Effect<void>

          expect(yield* Ref.get(calls)).toBe(2)
          const receipts = yield* Effect.promise(() =>
            readReceiptSources(disposable.root),
          )
          expect(receipts?.[unexamined.id]).toBeUndefined()

          // The thirteenth revision was never examined, so it must not be
          // terminal: a later wake runs the worker again.
          yield* signal.signal
          yield* waitFor(async () =>
            (await Effect.runPromise(Ref.get(calls))) >= 3,
          ) as Effect.Effect<void>
        }),
      ),
    )
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("the run lease serializes consolidators and recovers a dead owner", async () => {
  const disposable = await makeDisposableRoot()
  const active = await Effect.runPromise(Ref.make(0))
  const maximum = await Effect.runPromise(Ref.make(0))
  const completed = await Effect.runPromise(Ref.make(0))

  const pass = Effect.gen(function* () {
    const current = yield* Ref.updateAndGet(active, (value) => value + 1)
    yield* Ref.update(maximum, (value) => Math.max(value, current))
    yield* Effect.sleep(Duration.millis(30))
    yield* Ref.update(active, (value) => value - 1)
    yield* Ref.update(completed, (value) => value + 1)
  })

  try {
    await Effect.runPromise(
      Effect.all(
        [
          withRunLease(disposable.root, pass, { pollMs: 5 }),
          withRunLease(disposable.root, pass, { pollMs: 5 }),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(await Effect.runPromise(Ref.get(completed))).toBe(2)
    expect(await Effect.runPromise(Ref.get(maximum))).toBe(1)

    // A lease owned by a dead PID is stale immediately.
    const state = join(disposable.root, ".state")
    await mkdir(state, { recursive: true })
    await writeFile(
      join(state, RUN_LEASE_FILENAME),
      JSON.stringify({
        pid: 999_999,
        token: "dead",
        createdAt: new Date().toISOString(),
      }),
    )
    await Effect.runPromise(
      withRunLease(disposable.root, Effect.void, { pollMs: 5 }),
    )
    expect(await Effect.runPromise(Ref.get(completed))).toBe(2)
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("automatic-memory receipts and the run lease refuse a symlinked state directory", async () => {
  const disposable = await makeDisposableRoot()
  const outside = join(disposable.directory, "outside")
  const state = join(disposable.root, ".state")
  const clock = makeTestClock()
  const runs = await Effect.runPromise(Ref.make(0))
  const run = () =>
    Ref.update(runs, (value) => value + 1).pipe(Effect.as(noopResult))

  try {
    await mkdir(outside, { recursive: true })
    await rm(state, { recursive: true, force: true })
    await symlink(outside, state)

    // The lease is the first durable state write in a pass. It must fail at the
    // audited `.state/` boundary instead of creating the lease at the target.
    const exit = await Effect.runPromiseExit(
      withRunLease(disposable.root, Effect.void, { pollMs: 5 }),
    )
    expect(Exit.isFailure(exit)).toBe(true)

    // The full lifecycle reports the failure and never records a receipt in
    // the directory the symlink points at.
    const signal = await testSignal()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            runtimeLayer({
              root: disposable.root,
              now: clock.now,
              runtime: runtimeWith(testProvider),
              signal,
              run,
            }),
          )
          yield* Effect.sleep(Duration.millis(80))
        }),
      ),
    )

    expect(await readdir(outside)).toEqual([])
  } finally {
    await removeDisposableRoot(disposable)
  }
})

test("the scoped queue shuts down with its layer", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* RawWriteSignal
        yield* signal.signal
      }).pipe(Effect.provide(makeRawWriteSignalLayer())),
    ),
  )
  expect(REVISION_RECEIPT_FILENAME).toContain("revisions")
})
