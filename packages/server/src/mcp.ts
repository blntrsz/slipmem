import {
  makeMcpRegistrationsLayer,
  mcpInstructions,
  mcpServerName,
  mcpServerVersion,
  type McpServerOptions,
} from "@slipmem/mcp"
import { Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"

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
 * Pass the returned layer through `makeAppLayer`/`makeApiHandler`'s
 * `extraRoutes` option to serve it beside the JSON API.
 */
export const makeMcpHttp = (
  options: McpServerOptions,
): Layer.Layer<never, never, never> => {
  const { registrations } = makeMcpRegistrationsLayer(options)

  return McpServer.layerHttp({
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
    // The router requirements are discharged by `makeAppLayer`'s
    // `HttpRouter.toWebHandler`, exactly as they were for the previous MCP
    // endpoint. `extraRoutes` only accepts a fully provided route layer.
  }) as unknown as Layer.Layer<never, never, never>
}
