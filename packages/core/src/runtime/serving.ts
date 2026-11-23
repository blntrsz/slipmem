import { Effect, Layer } from "effect"

import {
  ApprovalService,
  ApprovalServiceLive,
  type ApprovalError,
} from "../approval/index.js"
import type { MarkdownError } from "../markdown/errors.js"
import {
  MarkdownNoteRepository,
  MarkdownNoteRepositoryLive,
} from "../markdown/repository.js"
import {
  MarkdownSearchIndex,
  MarkdownSearchIndexResilientFromRepository,
} from "../markdown/search-index.js"
import {
  PromptRecallService,
  PromptRecallServiceLive,
  type PromptRecallEvaluator,
} from "../recall/index.js"
import { WikiService, WikiServiceLive, type WikiError } from "../wiki/index.js"
import {
  makeMaintenanceLayer,
  makeRawWriteRepositoryLayer,
  makeRawWriteSignalLayer,
  RawWriteSignal,
  resolveAutomaticMemoryRuntime,
  type AutomaticMemoryRuntime,
} from "./automatic-memory.js"

/**
 * Configuration for the core services every serving surface shares.
 *
 * The repository is deliberately a requirement, not something this layer
 * builds. A host that needs an instrumented repository (for example the MCP
 * raw-write wake wrapper) can provide one repository instance and both the
 * JSON API and MCP surfaces will use it.
 */
export interface ServingServicesOptions {
  /** Exact cache directory for the disposable index. Defaults to XDG cache. */
  readonly cacheDir?: string
  /** Injectable clock for deterministic note filenames and approvals. */
  readonly now?: () => number
  /** Environment for approval policy, provenance, and wiki synthesis. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Explicit prompt-recall evaluator; otherwise recall reports unconfigured. */
  readonly recallEvaluator?: PromptRecallEvaluator
  /** Bounded per-note recall concurrency. */
  readonly recallConcurrency?: number
}

/**
 * The core serving graph over one Markdown repository: one resilient
 * disposable search index, the human approval queue, the read-only wiki, and
 * prompt recall.
 *
 * The approval service refreshes the same index instance the API and MCP read,
 * so a successful human approval is immediately visible to the next search or
 * health request. The MCP approval projection is added by the MCP package over
 * this same graph.
 */
export type ServingServices =
  | MarkdownSearchIndex
  | ApprovalService
  | WikiService
  | PromptRecallService

export const makeServingServicesLayer = (
  options: ServingServicesOptions = {},
): Layer.Layer<
  ServingServices,
  MarkdownError | ApprovalError | WikiError,
  MarkdownNoteRepository
> => {
  // A damaged cache degrades only index operations instead of failing the
  // whole host layer. The resilient service keeps the same tag and shape, so
  // every API and MCP consumer uses it without a second code path.
  const index = MarkdownSearchIndexResilientFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  )

  const services = Layer.unwrap(
    Effect.gen(function* () {
      const searchIndex = yield* MarkdownSearchIndex
      const refreshIndex = () =>
        searchIndex.refresh().pipe(Effect.asVoid)

      return Layer.mergeAll(
        ApprovalServiceLive({
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.env === undefined ? {} : { env: options.env }),
          refreshIndex,
        }),
        WikiServiceLive({
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.env === undefined ? {} : { env: options.env }),
        }),
        PromptRecallServiceLive({
          ...(options.recallEvaluator === undefined
            ? {}
            : { evaluator: options.recallEvaluator }),
          ...(options.recallConcurrency === undefined
            ? {}
            : { concurrency: options.recallConcurrency }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      )
    }),
  ).pipe(Layer.provideMerge(index))

  return services
}

/**
 * Configuration for the shared serving graph. It is intentionally concrete:
 * one note root, the disposable-index cache, an optional clock/environment,
 * prompt recall, and the resolved automatic-memory lifecycle.
 */
export interface ServingRuntimeOptions extends ServingServicesOptions {
  /** Absolute note root; the caller resolves it before building the graph. */
  readonly root: string
  /**
   * Resolved event-driven maintenance lifecycle. When omitted, it is resolved
   * from `env` (or `process.env`) and requires a primary chat model.
   */
  readonly automaticMemory?: AutomaticMemoryRuntime
}

/**
 * Every service the shared core serving graph provides. The MCP package adds
 * its `McpApprovalService` projection over this graph; transports add only
 * their registration layers.
 */
export type ServingRuntimeServices =
  | MarkdownNoteRepository
  | RawWriteSignal
  | ServingServices

export type ServingRuntimeError = MarkdownError | ApprovalError | WikiError

export interface ServingRuntime {
  readonly automaticMemory: AutomaticMemoryRuntime
  /**
   * One scoped graph for every surface. Build it once and provide it to the
   * JSON API routes and MCP registrations together; building it twice would
   * create two repositories, indexes, and consolidation workers.
   */
  readonly services: Layer.Layer<ServingRuntimeServices, ServingRuntimeError>
}

/**
 * Builds the shared scoped service graph for a note root.
 *
 * The graph is assembled once:
 *
 * - one base repository;
 * - one raw-write signal and one wrapped repository, so API and MCP writes
 *   both wake consolidation;
 * - one resilient disposable index, shared by the JSON API, MCP search, and
 *   approvals;
 * - one human approval service, wiki service, and prompt-recall service;
 * - one maintenance worker and one event-driven lifecycle when automatic
 *   memory is enabled.
 *
 * Provider resolution, the note-root watcher, durable receipts, the worker,
 * and the lifecycle all live in `core/runtime`, not in a transport package.
 */
export const makeServingRuntime = (
  options: ServingRuntimeOptions,
): ServingRuntime => {
  const automaticMemory =
    options.automaticMemory ??
    resolveAutomaticMemoryRuntime(options.env ?? process.env)

  const baseRepository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const rawWriteSignal = makeRawWriteSignalLayer()

  // `provideMerge` keeps the signal and wrapped repository in the output. The
  // base repository is the only service the wrapper still needs.
  const repository = makeRawWriteRepositoryLayer().pipe(
    Layer.provideMerge(rawWriteSignal),
    Layer.provide(baseRepository),
  )

  const coreServices = makeServingServicesLayer({
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.recallEvaluator === undefined
      ? {}
      : { recallEvaluator: options.recallEvaluator }),
    ...(options.recallConcurrency === undefined
      ? {}
      : { recallConcurrency: options.recallConcurrency }),
  }).pipe(Layer.provideMerge(repository))

  if (!automaticMemory.enabled) {
    return {
      automaticMemory,
      services: coreServices,
    }
  }

  const provider = automaticMemory.provider
  if (provider === undefined) {
    throw new Error(
      "Automatic memory is enabled but no maintenance provider was resolved.",
    )
  }

  const services = makeMaintenanceLayer(
    provider,
    automaticMemory,
    options.now === undefined ? {} : { now: options.now },
  ).pipe(Layer.provideMerge(coreServices))

  return { automaticMemory, services }
}
