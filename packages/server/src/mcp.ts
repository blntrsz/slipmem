import { McpProtocol, McpServer } from "effect/ai"
import { NoteRegistrations } from "./note-tools"

export const mcpServerName = "slipmem"
export const mcpServerVersion = "0.0.0"

const instructions = [
  "slipmem stores three kinds of notes: fleeting, permanent, and literature notes.",
  "Use the list and get tools to read notes, and create, update, and delete tools to manage them.",
  "Literature notes also require a reference to their source.",
].join(" ")

/**
 * Streamable HTTP MCP endpoint at `/mcp`. It shares the same note services and
 * SQLite database as the JSON API when both layers are provided the same
 * database layer.
 */
export const McpHttp = McpServer.layerHttp({
  name: mcpServerName,
  version: mcpServerVersion,
  instructions,
  path: "/mcp",
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2024_11_05,
  ],
  registrations: NoteRegistrations,
})
