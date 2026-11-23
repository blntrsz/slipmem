import { MarkdownNoteRepository, type MarkdownError } from "@slipmem/core"
import {
  makeApprovalService,
  type ApprovalError,
  type ApprovalServiceShape,
  type McpWriteInput,
  type McpWriteResult,
} from "@slipmem/core/approval"
import { Context, Effect, Layer } from "effect"
import type { McpServerOptions } from "./config"

/**
 * The only approval capability the MCP process may hold. `review`, `apply`,
 * and `reject` remain human-surface methods and are not structurally
 * reachable from the tool layer.
 */
export interface McpApprovalCapability {
  readonly submitMcp: (
    input: McpWriteInput,
  ) => Effect.Effect<McpWriteResult, ApprovalError>
}

/**
 * MCP-facing wrapper around the core approval service.
 *
 * The layer projects the service down to `submitMcp` at runtime as well as in
 * the type, so a future tool cannot call a human approval method even if a
 * type annotation is widened accidentally.
 */
export class McpApprovalService extends Context.Service<
  McpApprovalService,
  McpApprovalCapability
>()("@slipmem/mcp/ApprovalService") {}

export const McpApprovalServiceLive = (
  options: McpServerOptions,
  refreshIndex?: () => Effect.Effect<void, MarkdownError>,
): Layer.Layer<McpApprovalService, never, MarkdownNoteRepository> =>
  Layer.effect(
    McpApprovalService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      const env = options.env ?? process.env
      const actor = env.SLIPMEM_ACTOR
      const service: ApprovalServiceShape = yield* makeApprovalService(
        repository,
        {
          env,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(actor === undefined ? {} : { actor }),
          ...(refreshIndex === undefined ? {} : { refreshIndex }),
        },
      )
      return { submitMcp: service.submitMcp }
    }).pipe(Effect.orDie),
  )
