import { Markdown } from "@slipmem/schemas/markdown"

/**
 * Callers are deliberately coarse. The server constructs MCP callers; the CLI
 * and web construct human callers. Provenance strings are metadata, never
 * authentication.
 */
export type ApprovalCaller = "human" | "mcp"

/**
 * `approval` is the safe default. `direct-unsafe` is only reachable through the
 * explicit `SLIPMEM_MCP_WRITE_POLICY=direct` opt-in and never applies to
 * deletes. Direct permanent writes made under it record
 * `provenance.source: mcp-direct` so the unsafe choice stays visible in the
 * note file.
 */
export type McpWritePolicy = "approval" | "direct-unsafe"

export type ApprovalOperationName = Markdown.ApprovalOperation

export interface PolicyInput {
  readonly caller: ApprovalCaller
  readonly operation: ApprovalOperationName
  readonly currentType?: Markdown.NoteType
  readonly nextType?: Markdown.NoteType
  readonly mcpWritePolicy?: McpWritePolicy
}

export type PendingReason =
  | "permanent-create"
  | "permanent-update"
  | "permanent-reclassify"
  | "delete"

export type PolicyDecision =
  | { readonly disposition: "direct"; readonly unsafeDirect: boolean }
  | {
      readonly disposition: "pending"
      readonly reason: PendingReason
    }

const touchesPermanent = (
  currentType: Markdown.NoteType | undefined,
  nextType: Markdown.NoteType | undefined,
): boolean => currentType === "permanent" || nextType === "permanent"

/**
 * The frozen policy matrix from `docs/mvp-plan.md` section 8.1.
 *
 * - Humans write directly.
 * - MCP deletes are always pending, even under the unsafe opt-in.
 * - MCP permanent creates/updates and any reclassification to or from
 *   permanent are pending by default.
 * - Fleeting and literature writes stay direct.
 * - `direct-unsafe` bypasses pending only for permanent creates/updates and
 *   reclassification; it never bypasses a delete.
 */
export const decidePolicy = (input: PolicyInput): PolicyDecision => {
  if (input.caller === "human") {
    return { disposition: "direct", unsafeDirect: false }
  }

  if (input.operation === "delete") {
    return { disposition: "pending", reason: "delete" }
  }

  const permanent = touchesPermanent(input.currentType, input.nextType)
  if (!permanent) {
    return { disposition: "direct", unsafeDirect: false }
  }

  if (input.mcpWritePolicy === "direct-unsafe") {
    return { disposition: "direct", unsafeDirect: true }
  }

  if (input.operation === "reclassify") {
    return { disposition: "pending", reason: "permanent-reclassify" }
  }
  if (input.operation === "create") {
    return { disposition: "pending", reason: "permanent-create" }
  }
  return { disposition: "pending", reason: "permanent-update" }
}

export interface McpWritePolicyResolution {
  readonly policy: McpWritePolicy
  /** Present for an unrecognized value; the safe default is used. */
  readonly warning?: string
}

/**
 * Reads `SLIPMEM_MCP_WRITE_POLICY`. Unknown values fail closed to `approval`
 * and produce an actionable warning instead of silently enabling direct writes.
 */
export const resolveMcpWritePolicy = (
  env: Readonly<Record<string, string | undefined>>,
): McpWritePolicyResolution => {
  const raw = env.SLIPMEM_MCP_WRITE_POLICY?.trim()
  if (raw === undefined || raw === "" || raw === "approval") {
    return { policy: "approval" }
  }
  if (raw === "direct") {
    return { policy: "direct-unsafe" }
  }
  return {
    policy: "approval",
    warning: `SLIPMEM_MCP_WRITE_POLICY='${raw}' is not recognized. Use 'approval' (default) or 'direct' (unsafe). Falling back to approval.`,
  }
}

export const MCP_PROVENANCE_SOURCE = "mcp"
/** Application-defined source recorded for unsafe direct permanent writes. */
export const MCP_UNSAFE_DIRECT_PROVENANCE_SOURCE = "mcp-direct"

/**
 * Provenance for an MCP-originated write. `actor` comes from `SLIPMEM_ACTOR`
 * or the tool input and is never treated as authorization.
 */
export const mcpProvenance = (
  actor: string | undefined,
  unsafeDirect: boolean,
): Markdown.Provenance => ({
  source: unsafeDirect
    ? MCP_UNSAFE_DIRECT_PROVENANCE_SOURCE
    : MCP_PROVENANCE_SOURCE,
  ...(actor === undefined || actor.trim() === "" ? {} : { actor: actor.trim() }),
})
