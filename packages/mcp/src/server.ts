import {
  makeDatabaseLayer,
  mcpInstructions,
  mcpServerName,
  mcpServerVersion,
} from "@slipmem/server"
import { NoteRegistrations } from "@slipmem/server/note-tools"
import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { layer as stdioLayer } from "./stdio"

/**
 * Builds a complete stdio MCP server backed by a SQLite database file.
 *
 * Keeping the database path as an argument makes the same server layer usable
 * from tests with `":memory:"` and from the executable with a real file.
 */
export const makeServerLayer = (databasePath: string) => {
  const registrations = NoteRegistrations.pipe(Layer.provide(makeDatabaseLayer(databasePath)))

  return McpServer.layerStdio({
    name: mcpServerName,
    version: mcpServerVersion,
    instructions: mcpInstructions,
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2024_11_05],
    registrations,
  }).pipe(
    Layer.provide(stdioLayer),
    // Never write protocol messages and logs to the same stream.
    Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true)),
  )
}
