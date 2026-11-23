import { Data } from "effect"

/**
 * Service-level failures for prompt recall. Per-note evaluator failures are
 * reported in the result instead, so one unavailable or malformed answer does
 * not hide the notes that were evaluated successfully.
 */
export type PromptRecallErrorCode =
  | "invalid-prompt"
  | "repository-failure"
  | "evaluator-not-configured"

export interface PromptRecallErrorFields {
  readonly code: PromptRecallErrorCode
  readonly message: string
  readonly field?: string
}

export class PromptRecallError extends Data.TaggedError("PromptRecallError")<
  PromptRecallErrorFields
> {}

export const promptRecallError = (
  fields: PromptRecallErrorFields,
): PromptRecallError => new PromptRecallError(fields)

/** Typed failures a prompt-recall evaluator may report for one note. */
export type RecallEvaluatorErrorCode =
  | "timeout"
  | "transport"
  | "invalid-output"
  | "unavailable"
  | "rejected"

export interface RecallEvaluatorErrorFields {
  readonly code: RecallEvaluatorErrorCode
  readonly message: string
}

/**
 * An evaluator failure is separate from a negative decision. Callers must be
 * able to tell "the evaluator says this note is irrelevant" from "this note
 * was never judged".
 */
export class RecallEvaluatorError extends Data.TaggedError(
  "RecallEvaluatorError",
)<RecallEvaluatorErrorFields> {}

export const recallEvaluatorError = (
  fields: RecallEvaluatorErrorFields,
): RecallEvaluatorError => new RecallEvaluatorError(fields)
