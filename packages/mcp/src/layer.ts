import {
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndexFromRepository,
  PermanentMaintenanceWorkerLive,
  PromptRecallServiceLive,
} from "@slipmem/core"
import { WikiServiceLive } from "@slipmem/core/wiki"
import { Layer } from "effect"
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
 * Repository, disposable search index, and approval service for one note root.
 *
 * Both the stdio server and any HTTP registration share this layer shape, so
 * the same tools see the same files and the same pending proposals. The
 * repository is wrapped to emit a scoped raw-write signal after successful
 * fleeting/literature mutations; the worker and every tool receive that same
 * wrapped repository, so maintenance observes the same graph as writers.
 */
export const makeMarkdownServicesLayer = (options: McpServerOptions) => {
  const baseRepository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const rawWriteSignal = makeRawWriteSignalLayer()

  const repository = makeRawWriteRepositoryLayer().pipe(
    Layer.provide(baseRepository),
    Layer.provideMerge(rawWriteSignal),
  )

  const index = MarkdownSearchIndexFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  ).pipe(Layer.provide(repository))

  const approval = McpApprovalServiceLive(options).pipe(Layer.provide(repository))

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

  return Layer.mergeAll(repository, index, approval, wiki, recall)
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
