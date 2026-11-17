import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { mcpInstructions, mcpServerName, mcpServerVersion, type McpServerOptions } from "./config"
import { makeMarkdownServicesLayer } from "./layer"
import { McpNoteRegistrations } from "./tools"
import { layer as stdioLayer } from "./stdio"

/**
 * Builds the complete stdio MCP server for one Markdown note root.
 *
 * The same `McpNoteRegistrations` layer is transport-neutral: an HTTP endpoint
 * can provide the identical registrations with the same repository/index
 * services, so tool names, schemas, limits, and result shapes do not drift.
 */
export const makeServerLayer = (options: McpServerOptions) => {
  const registrations = McpNoteRegistrations.pipe(
    Layer.provide(makeMarkdownServicesLayer(options)),
  )

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
