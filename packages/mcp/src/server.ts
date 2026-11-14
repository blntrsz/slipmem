import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { makeDatabaseLayer } from "./database"
import { layer as stdioLayer } from "./stdio"
import { NoteRegistrations } from "./tools"

export const serverName = "slipmem"
export const serverVersion = "0.0.0"

const instructions = [
  "slipmem stores three kinds of notes: fleeting, permanent, and literature notes.",
  "Use the list and get tools to read notes, and create, update, and delete tools to manage them.",
  "Literature notes also require a reference to their source.",
].join(" ")

/**
 * Builds a complete stdio MCP server backed by a SQLite database file.
 *
 * Keeping the database path as an argument makes the same server layer usable
 * from tests with `":memory:"` and from the executable with a real file.
 */
export const makeServerLayer = (databasePath: string) => {
  const registrations = NoteRegistrations.pipe(Layer.provide(makeDatabaseLayer(databasePath)))

  return McpServer.layerStdio({
    name: serverName,
    version: serverVersion,
    instructions,
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2024_11_05],
    registrations,
  }).pipe(
    Layer.provide(stdioLayer),
    // Never write protocol messages and logs to the same stream.
    Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true)),
  )
}
