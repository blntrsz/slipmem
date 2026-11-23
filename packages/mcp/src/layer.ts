import {
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndex,
  MarkdownSearchIndexFromRepository,
  PermanentMaintenanceWorkerLive,
  PromptRecallServiceLive,
  type MarkdownError,
} from "@slipmem/core"
import { WikiServiceLive } from "@slipmem/core/wiki"
import { Effect, Layer } from "effect"
import { McpApprovalServiceLive } from "./approval"
import {
  makeAutomaticMemoryLayer,
  makeRawWriteRepositoryLayer,
  makeRawWriteSignalLayer,
  resolveAutomaticMemoryRuntime,
  resolveRecallProvider,
} from "./automatic-memory"
import type { McpServerOptions } from "./config"
import { McpNoteRegistrations } from "./tools"

/**
 * MCP-specific services over a caller-provided Markdown repository.
 *
 * This layer requires the base `MarkdownNoteRepository` but deliberately does
 * not construct one. The HTTP host can therefore provide its own repository
 * and search index once, and both the JSON API and `/mcp` observe the same
 * files and the same disposable index. The repository is wrapped to emit a
 * scoped raw-write signal after successful fleeting/literature mutations; the
 * worker and every tool receive that same wrapped repository, so maintenance
 * observes the same graph as writers.
 */
const makeMcpRepositoryServicesLayer = (
  options: McpServerOptions,
  refreshIndex?: () => Effect.Effect<void, MarkdownError>,
) => {
  const rawWriteSignal = makeRawWriteSignalLayer()

  const repository = makeRawWriteRepositoryLayer().pipe(
    Layer.provideMerge(rawWriteSignal),
  )

  // Intentionally a separate capability from the human core ApprovalService:
  // it exposes only submitMcp, while the host service owns review/apply/reject.
  // The HTTP build still gives it the host's refreshIndex hook so any future
  // direct path stays consistent with human applies.
  const approval = McpApprovalServiceLive(options, refreshIndex).pipe(
    Layer.provide(repository),
  )

  const wiki = WikiServiceLive({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }).pipe(Layer.provide(repository))

  const recallProvider =
    options.recallEvaluator === undefined
      ? resolveRecallProvider(options.env ?? process.env)
      : { evaluator: options.recallEvaluator }

  const recall = PromptRecallServiceLive({
    ...(recallProvider.evaluator === undefined
      ? {}
      : { evaluator: recallProvider.evaluator }),
    ...(options.recallConcurrency === undefined
      ? {}
      : { concurrency: options.recallConcurrency }),
  }).pipe(Layer.provide(repository))

  return Layer.mergeAll(repository, approval, wiki, recall)
}

/**
 * Self-contained MCP services for stdio, where no host repository exists yet.
 *
 * The repository is created here exactly once; the disposable index and every
 * MCP service are built over that same wrapped repository.
 */
export const makeMarkdownServicesLayer = (options: McpServerOptions) => {
  const baseRepository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const services = makeMcpRepositoryServicesLayer(options).pipe(
    Layer.provide(baseRepository),
  )

  const index = MarkdownSearchIndexFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  ).pipe(Layer.provide(services))

  return Layer.merge(services, index)
}

/**
 * HTTP registrations that reuse the host's repository and disposable index.
 *
 * The returned layer still requires `MarkdownNoteRepository` and
 * `MarkdownSearchIndex`; `makeAppLayer` provides both from one Markdown layer.
 * Only the MCP-specific approval, wiki, recall, wrapped-write signal, and
 * optional maintenance worker are added here.
 */
export const makeMcpSharedRegistrationsLayer = (options: McpServerOptions) => {
  const automaticMemory =
    options.automaticMemory ??
    resolveAutomaticMemoryRuntime(options.env ?? process.env)
  const services = Layer.unwrap(
    Effect.gen(function* () {
      const index = yield* MarkdownSearchIndex
      return makeMcpRepositoryServicesLayer(options, () =>
        index.refresh().pipe(Effect.asVoid),
      )
    }),
  )

  if (!automaticMemory.enabled) {
    return {
      automaticMemory,
      registrations: McpNoteRegistrations.pipe(Layer.provide(services)),
    }
  }

  const provider = automaticMemory.provider
  if (provider === undefined) {
    throw new Error(
      "Automatic memory is enabled but no maintenance provider was resolved.",
    )
  }

  const worker = PermanentMaintenanceWorkerLive({
    provider: provider.maintenance,
    ...(options.now === undefined ? {} : { now: options.now }),
  }).pipe(Layer.provide(services), Layer.orDie)

  return {
    automaticMemory,
    registrations: Layer.merge(
      McpNoteRegistrations,
      makeAutomaticMemoryLayer(automaticMemory),
    ).pipe(Layer.provide(Layer.merge(services, worker))),
  }
}

/**
 * The common runtime composition for both MCP transports.
 *
 * Tool registrations and the opt-in event-driven maintenance lifecycle share
 * one repository/index graph. The lifecycle is forked into the server layer's
 * scope, so HTTP handler disposal and stdio SIGINT/SIGTERM both stop it. Raw
 * writes and the note-root watcher signal the same scoped queue.
 */
export const makeMcpRegistrationsLayer = (options: McpServerOptions) => {
  const automaticMemory =
    options.automaticMemory ??
    resolveAutomaticMemoryRuntime(options.env ?? process.env)
  const services = makeMarkdownServicesLayer(options)

  if (!automaticMemory.enabled) {
    return {
      automaticMemory,
      registrations: McpNoteRegistrations.pipe(Layer.provide(services)),
    }
  }

  const provider = automaticMemory.provider
  if (provider === undefined) {
    throw new Error(
      "Automatic memory is enabled but no maintenance provider was resolved.",
    )
  }

  // `provideMerge` keeps the repository, index, approval, recall, and wiki
  // services and adds the worker to the same graph. The maintenance worker is
  // not an MCP tool; it writes with provenance source "maintenance" and never
  // receives approval or delete capabilities.
  const runtime = PermanentMaintenanceWorkerLive({
    provider: provider.maintenance,
    ...(options.now === undefined ? {} : { now: options.now }),
  }).pipe(Layer.provideMerge(services), Layer.orDie)

  return {
    automaticMemory,
    registrations: Layer.merge(
      McpNoteRegistrations,
      makeAutomaticMemoryLayer(automaticMemory),
    ).pipe(Layer.provide(runtime)),
  }
}
