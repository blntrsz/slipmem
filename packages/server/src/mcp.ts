import {
  makeMcpSharedRegistrationsLayer,
  mcpInstructions,
  mcpServerName,
  mcpServerVersion,
  type McpServerOptions,
} from "@slipmem/mcp"
import type { MarkdownNoteRepository, MarkdownSearchIndex } from "@slipmem/core"
import type { WikiError } from "@slipmem/core/wiki"
import type { Cause, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import type { HttpRouter } from "effect/http"

export { mcpInstructions, mcpServerName, mcpServerVersion }

/**
 * Streamable HTTP MCP endpoint over one Markdown note root.
 *
 * It uses the exact same registrations and lifecycle composition as the stdio
 * server, so tool names, input schemas, bounds, approval behavior, result
 * shapes, and the required serving/chat model are shared rather than
 * reimplemented. When `options.automaticMemory` is omitted, the same
 * environment resolver as stdio runs and a missing/partial primary chat model
 * is a startup error. A programmatic host or test can still inject an explicit
 * `AutomaticMemoryRuntime` (including `{ enabled: false }`) and a recall
 * evaluator instead.
 *
 * Unlike stdio, this layer does not build its own repository or index. It
 * requires the host's `MarkdownNoteRepository` and `MarkdownSearchIndex`, so
 * `makeAppLayer` shares one Markdown service graph with the JSON API. The
 * declared `HttpRouter` requirement is discharged when the app is built.
 *
 * Pass the returned layer through `makeAppLayer`/`makeApiHandler`'s
 * `extraRoutes` option to serve it beside the JSON API.
 */
export type McpHttpRoutes = Layer.Layer<
  McpServer.McpServer,
  Cause.IllegalArgumentError | WikiError,
  HttpRouter.HttpRouter | MarkdownNoteRepository | MarkdownSearchIndex
>

export const makeMcpHttpRoutes = <A, E, R>(
  registrations: Layer.Layer<A, E, R>,
) =>
  McpServer.layerHttp({
    name: mcpServerName,
    version: mcpServerVersion,
    instructions: mcpInstructions,
    path: "/mcp",
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2024_11_05,
    ],
    registrations,
  })

export const makeMcpHttp = (options: McpServerOptions): McpHttpRoutes => {
  const { registrations } = makeMcpSharedRegistrationsLayer(options)

  return makeMcpHttpRoutes(registrations)
}
