import { Effect, Schema } from "effect"
import {
  recallEvaluatorError,
  type RecallEvaluatorError,
} from "./errors.js"

/** A prompt is user intent, not trusted note content. Bound it explicitly. */
export const MAX_PROMPT_CHARS = 8_000

/** At most four model notes are evaluated at once unless a host overrides it. */
export const DEFAULT_RECALL_CONCURRENCY = 4
export const MAX_RECALL_CONCURRENCY = 16

/** Bounded evaluator messages keep one failed note from dominating output. */
export const MAX_RECALL_ERROR_MESSAGE_CHARS = 300

export type RecallVerdict = "relevant" | "irrelevant"

/**
 * The exact, bounded note fields passed to an evaluator. Note text lives in
 * its own field and is explicitly untrusted; an evaluator must never treat it
 * as instructions, permissions, or output format.
 */
export interface PromptRecallNote {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly tags: ReadonlyArray<string>
  readonly updatedAt: number
}

export interface PromptRecallEvaluation {
  readonly prompt: string
  readonly note: PromptRecallNote
}

/**
 * A typed relevance decision. This is a closed decision, not free-form model
 * prose: a Jev Choice question maps directly to `verdict`, and confidence is
 * optional calibrated metadata.
 */
export interface PromptRecallDecision
  extends Schema.Schema.Type<typeof PromptRecallDecision> {}
export const PromptRecallDecision = Schema.Struct({
  verdict: Schema.Literals(["relevant", "irrelevant"]),
  confidence: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Recall.PromptRecallDecision" })

/**
 * The injectable evaluator boundary. Implementations can call Jev, another
 * decision model, or a test double. There is deliberately no local heuristic
 * fallback: an unconfigured service fails closed instead of pretending a
 * keyword search is a model decision.
 */
export interface PromptRecallEvaluator {
  /** Display label for the evaluator, for example `jev-1.13.0`. */
  readonly model?: string
  readonly evaluate: (
    input: PromptRecallEvaluation,
  ) => Effect.Effect<PromptRecallDecision, RecallEvaluatorError>
}

const boundedMessage = (message: string): string => {
  const collapsed = message.replace(/\s+/g, " ").trim()
  return collapsed.length <= MAX_RECALL_ERROR_MESSAGE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_RECALL_ERROR_MESSAGE_CHARS - 1).trimEnd()}…`
}

/**
 * Validates what an adapter actually returned. TypeScript types cannot protect
 * a runtime boundary, so a malformed verdict or confidence is a typed
 * per-note failure and never a silent default decision.
 */
export const decodePromptRecallDecision = (
  value: unknown,
): Effect.Effect<PromptRecallDecision, RecallEvaluatorError> =>
  Schema.decodeUnknownEffect(PromptRecallDecision)(value).pipe(
    Effect.mapError((issue) =>
      recallEvaluatorError({
        code: "invalid-output",
        message: boundedMessage(
          `The evaluator returned a decision that does not match the typed contract: ${String(issue)}`,
        ),
      }),
    ),
    Effect.flatMap((decision) =>
      decision.confidence === undefined ||
      (decision.confidence >= 0 && decision.confidence <= 1)
        ? Effect.succeed(decision)
        : Effect.fail(
            recallEvaluatorError({
              code: "invalid-output",
              message:
                "The evaluator returned a confidence outside the 0..1 range.",
            }),
          ),
    ),
  )

export const boundRecallErrorMessage = boundedMessage
