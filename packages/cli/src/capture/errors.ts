import { Data } from "effect"

export type GitCaptureErrorCode =
  | "invalid-config"
  | "invalid-commit"
  | "git-failed"
  | "commit-missing"
  | "checkout-mismatch"
  | "not-ancestor"
  | "diff-too-large"
  | "model-failed"
  | "model-output-invalid"
  | "evidence-invalid"
  | "write-failed"
  | "checkpoint-failed"
  | "consolidation-locked"
  | "consolidation-failed"

/**
 * A typed Git-capture failure. Messages never include a credential, provider
 * response body, or full diff content. Paths are repository-relative.
 */
export class GitCaptureError extends Data.TaggedError("GitCaptureError")<{
  readonly code: GitCaptureErrorCode
  readonly message: string
  readonly path?: string
  readonly field?: string
}> {}

export const gitCaptureError = (fields: {
  readonly code: GitCaptureErrorCode
  readonly message: string
  readonly path?: string
  readonly field?: string
}): GitCaptureError => new GitCaptureError(fields)
