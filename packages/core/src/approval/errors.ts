import { Data } from "effect"

// Approval state is local, but it is still a trust boundary: proposal files are
// ordinary JSON under `.state/` and may be edited by a person or a stale tool.
// One error type keeps every failure actionable for the CLI and web review page
// without leaking a nested parser/index failure union into the surfaces.
export type ApprovalErrorCode =
  | "invalid-proposal"
  | "proposal-not-found"
  | "proposal-expired"
  | "proposal-queue-full"
  | "proposal-write-failed"
  | "proposal-read-failed"
  | "proposal-id-conflict"
  | "target-missing"
  | "target-exists"
  | "stale-base"
  | "repository-failure"
  | "apply-failed"
  | "policy-invalid"

export interface ApprovalErrorFields {
  readonly code: ApprovalErrorCode
  readonly message: string
  /** Proposal file or note file involved in the failure. */
  readonly path?: string
  readonly proposalId?: string
  readonly noteId?: string
  readonly field?: string
}

/**
 * A typed approval failure. `code` is stable enough for tests and surfaces;
 * `message` always says what the caller can do next.
 */
export class ApprovalError extends Data.TaggedError("ApprovalError")<ApprovalErrorFields> {}

export const approvalError = (fields: ApprovalErrorFields): ApprovalError =>
  new ApprovalError(fields)
