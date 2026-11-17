import { MarkdownNoteRepository } from "@slipmem/core"
import {
  makeApprovalService,
  type ApprovalServiceShape,
} from "@slipmem/core/approval"
import { Context, Effect, Layer } from "effect"
import type { McpServerOptions } from "./config"

/**
 * MCP-facing wrapper around the core approval service.
 *
 * This wrapper deliberately exposes only `submitMcp` to the tool layer. The
 * approval service's `review`, `apply`, and `reject` methods stay in the human
 * CLI/web surfaces; there is no MCP tool or registration for them.
 */
export class McpApprovalService extends Context.Service<
  McpApprovalService,
  ApprovalServiceShape
>()("@slipmem/mcp/ApprovalService") {}

export const McpApprovalServiceLive = (
  options: McpServerOptions,
): Layer.Layer<McpApprovalService, never, MarkdownNoteRepository> =>
  Layer.effect(
    McpApprovalService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      const env = options.env ?? process.env
      const actor = env.SLIPMEM_ACTOR
      return yield* makeApprovalService(repository, {
        env,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(actor === undefined ? {} : { actor }),
      })
    }).pipe(Effect.orDie),
  )
