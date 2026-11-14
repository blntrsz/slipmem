export * as MemoryScope from "./memory-scope.js"

import { Schema } from "effect"

/**
 * A memory scope is a namespace, not an authorization boundary.
 *
 * Notes are partitioned by scope so a project, agent, or session can keep its
 * own working set without colliding with another namespace. The scope is not a
 * permission check: callers that may read a scope are decided by the embedding
 * system, not by this value.
 *
 * The grammar is intentionally conservative and URL/CLI friendly. It allows
 * names such as `global`, `project:slipmem`, `agent:reviewer`, and
 * `project:slipmem/session:123`.
 */
export const Scope = Schema.String.check(
  Schema.isMinLength(1, { message: "Scope must not be empty." }),
  Schema.isMaxLength(200, {
    message: "Scope must be 200 characters or fewer.",
  }),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, {
    message:
      "Scope must start with a letter or digit and contain only letters, digits, '.', '_', ':', '/', and '-'.",
  }),
).pipe(
  Schema.brand("MemoryScope.Scope"),
  Schema.annotate({ identifier: "MemoryScope.Scope" }),
)
export type Scope = typeof Scope.Type

/**
 * The namespace used when a caller does not name one.
 *
 * Keeping a single default is what makes the scope migration backwards
 * compatible: every note written before scopes existed is adopted into
 * `global`, and legacy callers keep reading and writing the same rows.
 */
export const DEFAULT_SCOPE: Scope = Schema.decodeUnknownSync(Scope)("global")
