import type { MarkdownError } from "@slipmem/core"
import type { ToolFailure } from "./schemas"

/**
 * Converts a core note failure into the stable shape an MCP client receives.
 * The code is preserved so clients can distinguish a missing note from a path
 * or validation failure without parsing prose.
 */
export const toolFailure = (error: MarkdownError): ToolFailure => ({
  code: error.code,
  message: error.message,
})

export const failure = (code: string, message: string): ToolFailure => ({
  code,
  message,
})

export const noteNotFound = (kind: string, id: string): ToolFailure =>
  failure("not-found", `${kind} not found: ${id}`)
