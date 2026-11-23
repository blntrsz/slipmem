import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { mcpInstructions, mcpServerName, mcpServerVersion, type McpServerOptions } from "./config"
import { makeMcpRegistrationsLayer } from "./layer"
import { layer as stdioLayer } from "./stdio"

/**
 * Builds the complete stdio MCP server for one Markdown note root.
 *
 * The same registrations layer is transport-neutral: an HTTP endpoint can
 * provide the identical registrations with the same repository/index
 * services, so tool names, schemas, limits, and result shapes do not drift.
 *
 * When automatic memory is enabled, the registrations layer also starts the
 * scoped write queue, cross-process note watcher, and run lease. Both transports
 * therefore share the same event-driven lifecycle rather than a periodic timer.
 */
export const makeServerLayer = (options: McpServerOptions) => {
  const { registrations } = makeMcpRegistrationsLayer(options)

  return McpServer.layerStdio({
    name: mcpServerName,
    version: mcpServerVersion,
    instructions: mcpInstructions,
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2024_11_05,
    ],
    registrations,
  }).pipe(
    Layer.provide(stdioLayer),
    // Never write protocol messages and logs to the same stream.
    Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true)),
  )
}
