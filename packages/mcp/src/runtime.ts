import { MarkdownSearchIndex } from "@slipmem/core"
import {
  makeServingRuntime as makeCoreServingRuntime,
  type AutomaticMemoryRuntime,
  type ServingRuntimeError as CoreServingRuntimeError,
  type ServingRuntimeServices as CoreServingRuntimeServices,
} from "@slipmem/core/runtime"
import { Effect, Layer } from "effect"

import { McpApprovalService, McpApprovalServiceLive } from "./approval"
import type { McpServerOptions } from "./config"
import { McpNoteRegistrations } from "./tools"

/**
 * The shared core graph plus the one MCP-specific capability: the approval
 * projection that exposes only `submitMcp`. Provider resolution, the watcher,
 * receipts, the worker, the lifecycle, and the run lease are all owned by
 * `@slipmem/core/runtime`.
 */
export type ServingRuntimeServices =
  | CoreServingRuntimeServices
  | McpApprovalService

export type ServingRuntimeError = CoreServingRuntimeError

export interface ServingRuntime {
  readonly automaticMemory: AutomaticMemoryRuntime
  /**
   * One scoped graph for every surface. Build it once and provide it to the
   * JSON API routes and MCP registrations together; building it twice would
   * create two repositories, indexes, and consolidation workers.
   */
  readonly services: Layer.Layer<ServingRuntimeServices, ServingRuntimeError>
  /** Transport-neutral MCP registrations over `services`. */
  readonly registrations: typeof McpNoteRegistrations
}

/**
 * Adds only the MCP approval projection to the shared core serving graph.
 *
 * The MCP approval service refreshes the same resilient index instance as the
 * human approval service, so a direct MCP apply and a human approval cannot
 * leave different index views behind. No provider, watcher, receipt, worker,
 * or lifecycle construction lives here.
 */
export const makeServingRuntime = (
  options: McpServerOptions,
): ServingRuntime => {
  const base = makeCoreServingRuntime({
    root: options.root,
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.recallEvaluator === undefined
      ? {}
      : { recallEvaluator: options.recallEvaluator }),
    ...(options.recallConcurrency === undefined
      ? {}
      : { recallConcurrency: options.recallConcurrency }),
    ...(options.automaticMemory === undefined
      ? {}
      : { automaticMemory: options.automaticMemory }),
  })

  const mcpApproval = Layer.unwrap(
    Effect.gen(function* () {
      const index = yield* MarkdownSearchIndex
      return McpApprovalServiceLive(options, () =>
        index.refresh().pipe(Effect.asVoid),
      )
    }),
  ).pipe(Layer.provideMerge(base.services))

  return {
    automaticMemory: base.automaticMemory,
    services: mcpApproval,
    registrations: McpNoteRegistrations,
  }
}

/**
 * Convenience for a standalone transport such as stdio: it returns MCP
 * registrations already provided by the shared graph. The HTTP host should use
 * `makeServingRuntime` directly so the JSON API receives the same graph.
 */
export const makeServingRegistrationsLayer = (options: McpServerOptions) => {
  const runtime = makeServingRuntime(options)
  return {
    automaticMemory: runtime.automaticMemory,
    registrations: runtime.registrations.pipe(Layer.provide(runtime.services)),
  }
}
