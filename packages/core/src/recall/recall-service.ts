import { Context, Effect, Layer } from "effect"
import { managedPermanentMetadata } from "../maintenance/metadata.js"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import {
  MarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  promptRecallError,
  recallEvaluatorError,
  type PromptRecallError,
  type RecallEvaluatorError,
} from "./errors.js"
import {
  boundRecallErrorMessage,
  decodePromptRecallDecision,
  DEFAULT_RECALL_CONCURRENCY,
  MAX_PROMPT_CHARS,
  MAX_RECALL_CONCURRENCY,
  type PromptRecallDecision,
  type PromptRecallEvaluator,
} from "./evaluator.js"

/** Only the repository operations prompt recall needs. */
export type PromptRecallRepository = Pick<
  MarkdownNoteRepositoryShape,
  "root" | "scan"
>

export const DEFAULT_RECALL_NOTE_TIMEOUT_MS = 30_000
export const MAX_RECALL_NOTE_TIMEOUT_MS = 120_000
export const DEFAULT_RECALL_DEADLINE_MS = 60_000
export const MAX_RECALL_DEADLINE_MS = 600_000
export const DEFAULT_RECALL_MAX_NOTES = 50
export const MAX_RECALL_MAX_NOTES = 200

export interface PromptRecallServiceConfig {
  /**
   * Required evaluator boundary. An absent evaluator makes every recall fail
   * with `evaluator-not-configured`; there is no keyword or heuristic fallback
   * that could be mistaken for a model decision.
   */
  readonly evaluator?: PromptRecallEvaluator
  /** Bounded per-note concurrency. Defaults to 4 and clamps to 1..16. */
  readonly concurrency?: number
  /** Per-note service deadline. Defaults to 30 seconds and clamps to 1..120 s. */
  readonly timeoutMs?: number
  /** Shared deadline for the whole call. Defaults to 60 seconds, max 10 min. */
  readonly deadlineMs?: number
  /** Maximum eligible notes evaluated per call. Defaults to 50, max 200. */
  readonly maxNotes?: number
  /** Clock used for the shared deadline; injectable for deterministic tests. */
  readonly now?: () => number
}

export interface PromptRecallInput {
  readonly prompt: string
}

export interface PromptRecallFailure {
  readonly code: RecallEvaluatorError["code"]
  readonly message: string
}

export type PromptRecallResult =
  | {
      readonly status: "relevant"
      readonly note: ParsedMarkdownNote
      readonly confidence?: number
    }
  | {
      readonly status: "irrelevant"
      readonly note: ParsedMarkdownNote
      readonly confidence?: number
    }
  | {
      readonly status: "failed"
      readonly note: ParsedMarkdownNote
      readonly error: PromptRecallFailure
    }

export interface PromptRecallCounts {
  /** Total current permanent notes eligible before the call bounds applied. */
  readonly eligible: number
  readonly relevant: number
  readonly irrelevant: number
  readonly failed: number
  /** Eligible notes not evaluated because the result cap or call deadline hit. */
  readonly skipped: number
}

export interface PromptRecallReport {
  readonly prompt: string
  /** Evaluator label, or null when the evaluator does not name a model. */
  readonly evaluator: string | null
  readonly notes: ReadonlyArray<PromptRecallResult>
  readonly counts: PromptRecallCounts
}

export interface PromptRecallServiceShape {
  readonly root: string
  /**
   * Evaluates eligible permanent notes independently against one prompt.
   * Each note has its own service timeout and the whole call shares a deadline.
   * A per-note failure is retained as a typed failed result; notes left over
   * by the result cap or deadline are counted as skipped, never silently
   * dropped.
   */
  readonly recall: (
    input: PromptRecallInput,
  ) => Effect.Effect<PromptRecallReport, PromptRecallError>
}

export class PromptRecallService extends Context.Service<
  PromptRecallService,
  PromptRecallServiceShape
>()("@slipmem/core/PromptRecallService") {}

const resolveConcurrency = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECALL_CONCURRENCY
  }
  return Math.max(1, Math.min(MAX_RECALL_CONCURRENCY, Math.trunc(value)))
}

const resolveBound = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.min(maximum, Math.trunc(value)))
}

const normalizePrompt = (
  prompt: string,
): Effect.Effect<string, PromptRecallError> => {
  const normalized = prompt.trim()
  if (normalized.length === 0) {
    return Effect.fail(
      promptRecallError({
        code: "invalid-prompt",
        field: "prompt",
        message: "Prompt recall requires a non-blank prompt.",
      }),
    )
  }
  if (normalized.length > MAX_PROMPT_CHARS) {
    return Effect.fail(
      promptRecallError({
        code: "invalid-prompt",
        field: "prompt",
        message: `Prompt recall is limited to ${MAX_PROMPT_CHARS} characters; received ${normalized.length}.`,
      }),
    )
  }
  return Effect.succeed(normalized)
}

const failure = (
  error: RecallEvaluatorError,
): PromptRecallFailure => ({
  code: error.code,
  message: boundRecallErrorMessage(error.message),
})

const decisionResult = (
  note: ParsedMarkdownNote,
  decision: PromptRecallDecision,
): PromptRecallResult =>
  decision.verdict === "relevant"
    ? {
        status: "relevant",
        note,
        ...(decision.confidence === undefined
          ? {}
          : { confidence: decision.confidence }),
      }
    : {
        status: "irrelevant",
        note,
        ...(decision.confidence === undefined
          ? {}
          : { confidence: decision.confidence }),
      }

const countResults = (
  results: ReadonlyArray<PromptRecallResult>,
  eligible: number,
): PromptRecallCounts => ({
  eligible,
  relevant: results.filter((result) => result.status === "relevant").length,
  irrelevant: results.filter((result) => result.status === "irrelevant").length,
  failed: results.filter((result) => result.status === "failed").length,
  skipped: Math.max(0, eligible - results.length),
})

/**
 * Keeps manual notes and human-edited permanents recallable, but excludes an
 * intact automatically managed permanent once any source revision no longer
 * matches the durable note. A missing source is stale too: its content can no
 * longer be rechecked against the revision the permanent was built from.
 */
const isCurrentPermanent = (
  note: ParsedMarkdownNote,
  notesById: ReadonlyMap<string, ParsedMarkdownNote>,
): boolean => {
  const managed = managedPermanentMetadata(note)
  if (managed === null) {
    return true
  }
  return managed.sources.every((source) => {
    const current = notesById.get(source.id)
    return current !== undefined && current.contentHash === source.contentHash
  })
}

/**
 * Read-only prompt recall over permanent notes.
 *
 * Each selected note is a separate evaluator call with its own timeout. The
 * calls are isolated: failures are returned alongside successful decisions,
 * and concurrency, result count, and the shared call deadline are bounded.
 * Notes left unevaluated by those bounds are reported as `skipped`, never
 * silently dropped. Note bodies are passed as untrusted data, never spliced
 * into an instruction string. Nothing is persisted.
 */
export const makePromptRecallService = (
  repository: PromptRecallRepository,
  config: PromptRecallServiceConfig = {},
): PromptRecallServiceShape => {
  const concurrency = resolveConcurrency(config.concurrency)
  const noteTimeoutMs = resolveBound(
    config.timeoutMs,
    DEFAULT_RECALL_NOTE_TIMEOUT_MS,
    MAX_RECALL_NOTE_TIMEOUT_MS,
  )
  const deadlineMs = resolveBound(
    config.deadlineMs,
    DEFAULT_RECALL_DEADLINE_MS,
    MAX_RECALL_DEADLINE_MS,
  )
  const maxNotes = resolveBound(
    config.maxNotes,
    DEFAULT_RECALL_MAX_NOTES,
    MAX_RECALL_MAX_NOTES,
  )
  const now = config.now ?? Date.now

  const evaluateOne = (
    evaluator: PromptRecallEvaluator,
    prompt: string,
    note: ParsedMarkdownNote,
    timeoutMs: number,
  ): Effect.Effect<PromptRecallResult> =>
    Effect.suspend(() =>
      evaluator.evaluate({
        prompt,
        note: {
          id: note.id,
          title: note.metadata.title,
          content: note.body,
          tags: note.metadata.tags ?? [],
          updatedAt: note.info.updatedAt,
        },
      }),
    ).pipe(
      // The service owns a hard per-note ceiling so one non-answering adapter
      // cannot consume the whole shared call deadline.
      Effect.timeout(timeoutMs),
      Effect.flatMap(decodePromptRecallDecision),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? recallEvaluatorError({
              code: "timeout",
              message: `Prompt recall did not finish one note within ${timeoutMs} ms.`,
            })
          : error,
      ),
      Effect.match({
        onFailure: (error) => ({
          status: "failed" as const,
          note,
          error: failure(error),
        }),
        onSuccess: (decision) => decisionResult(note, decision),
      }),
      // An evaluator is an integration boundary, so a thrown adapter bug is a
      // per-note failure too. The defect text is never copied into a
      // user-visible result because it can contain prompts, notes, or secrets.
      // Interruption still propagates normally.
      Effect.catchDefect(() =>
        Effect.succeed({
          status: "failed" as const,
          note,
          error: failure(
            recallEvaluatorError({
              code: "unavailable",
              message:
                "The recall evaluator adapter failed before returning a decision.",
            }),
          ),
        }),
      ),
    )

  const recall = (
    input: PromptRecallInput,
  ): Effect.Effect<PromptRecallReport, PromptRecallError> =>
    Effect.gen(function* () {
      const evaluator = config.evaluator
      if (evaluator === undefined) {
        return yield* Effect.fail(
          promptRecallError({
            code: "evaluator-not-configured",
            message:
              "Prompt recall needs an explicitly configured evaluator. No heuristic fallback is used; inject a Jev or other decision-model adapter.",
          }),
        )
      }

      const deadlineAt = now() + deadlineMs
      const prompt = yield* normalizePrompt(input.prompt)
      const scan = yield* repository.scan().pipe(
        Effect.mapError((error) =>
          promptRecallError({
            code: "repository-failure",
            message: `Could not read permanent notes for prompt recall: ${error.message}`,
            field: error.path,
          }),
        ),
      )
      const notesById = new Map(
        scan.notes.map((note) => [note.id, note] as const),
      )
      const notes = scan.notes.filter(
        (note) =>
          note.metadata.type === "permanent" &&
          isCurrentPermanent(note, notesById),
      )
      const selected = notes.slice(0, maxNotes)

      const evaluated = yield* Effect.forEach(
        selected,
        (note) =>
          Effect.suspend(() => {
            const remaining = deadlineAt - now()
            if (remaining <= 0) {
              return Effect.succeed(null)
            }
            return evaluateOne(evaluator, prompt, note, noteTimeoutMs).pipe(
              // The shared deadline is a skip, not a per-note model failure:
              // the note was never judged by the evaluator.
              Effect.timeout(remaining),
              Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
            )
          }),
        { concurrency },
      )
      const results = evaluated.filter(
        (result): result is PromptRecallResult => result !== null,
      )

      return {
        prompt,
        evaluator: evaluator.model ?? null,
        notes: results,
        counts: countResults(results, notes.length),
      }
    })

  return { root: repository.root, recall }
}

export const PromptRecallServiceLive = (
  config: PromptRecallServiceConfig = {},
): Layer.Layer<PromptRecallService, never, MarkdownNoteRepository> =>
  Layer.effect(
    PromptRecallService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      return makePromptRecallService(repository, config)
    }),
  )
