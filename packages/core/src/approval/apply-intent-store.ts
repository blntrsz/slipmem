import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Option } from "effect"
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteFile } from "../markdown/atomic.js"
import { MarkdownError } from "../markdown/errors.js"
import { ensureStateSubdirectory, stateDirectory } from "../markdown/root.js"
import { type ApprovalError, approvalError } from "./errors.js"
import { PROPOSAL_ID_PATTERN } from "./proposal-store.js"

/**
 * A durable record written before a human approval mutates a note. It is the
 * crash-recovery anchor between the proposal file and the Markdown file:
 *
 * - `prepared` means an apply may have started. A retry compares the note with
 *   the proposal (create/update) or its base hash (delete) before writing again.
 * - `applied` means the note mutation was verified and its result hash (or
 *   backup path) was recorded. A retry can return the same result and finish
 *   cleanup without touching the note.
 *
 * The record lives outside the note root's note namespace under `.state/`, so
 * `scan` and `check` never see it as a note.
 */
export const APPLY_INTENT_DIRECTORY = "apply-intent"
const INTENT_SUFFIX = ".json"
const HASH_PATTERN = /^[0-9a-f]{64}$/

export type ApplyIntentPhase = "prepared" | "applied"

export interface ApplyIntent {
  readonly proposalId: string
  readonly operation: Markdown.ApprovalOperation
  readonly noteId: string
  readonly path: string
  readonly phase: ApplyIntentPhase
  /** Required for update/reclassify/delete; absent for create. */
  readonly baseHash?: string
  /** Fingerprint of the proposal content this intent was prepared from. */
  readonly proposalHash: string
  readonly preparedAt: string
  readonly appliedAt?: string
  /** Whole-file hash of the note after a verified create/update/reclassify. */
  readonly resultHash?: string
  /** Repository backup path after a verified delete. */
  readonly backupPath?: string
}

export interface ApplyIntentStoreShape {
  readonly get: (
    proposalId: string,
  ) => Effect.Effect<Option.Option<ApplyIntent>, ApprovalError>
  readonly put: (intent: ApplyIntent) => Effect.Effect<ApplyIntent, ApprovalError>
  readonly remove: (proposalId: string) => Effect.Effect<boolean, ApprovalError>
}

export interface ApplyIntentStoreConfig {
  readonly root: string
}

const stateFailure = (
  path: string,
  action: string,
  cause: unknown,
  code: "apply-failed" | "apply-unknown",
): ApprovalError =>
  approvalError({
    code,
    path: cause instanceof MarkdownError ? cause.path : path,
    message: `Could not ${action}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  })

const invalidIntent = (path: string, message: string): ApprovalError =>
  approvalError({
    code: "apply-unknown",
    path,
    message: `${message} No note was written by this attempt; inspect .state/${APPLY_INTENT_DIRECTORY} before retrying.`,
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOperation = (
  value: unknown,
): value is Markdown.ApprovalOperation =>
  value === "create" ||
  value === "update" ||
  value === "delete" ||
  value === "reclassify"

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value))

const decodeIntent = (
  raw: unknown,
  path: string,
  root: string,
  expectedId: string,
): Effect.Effect<ApplyIntent, ApprovalError> =>
  Effect.gen(function* () {
    if (!isRecord(raw)) {
      return yield* Effect.fail(invalidIntent(path, "The apply intent is not a JSON object."))
    }

    const proposalId = raw.proposalId
    const operation = raw.operation
    const noteId = raw.noteId
    const targetPath = raw.path
    const phase = raw.phase
    const baseHash = raw.baseHash
    const proposalHash = raw.proposalHash
    const preparedAt = raw.preparedAt
    const appliedAt = raw.appliedAt
    const resultHash = raw.resultHash
    const backupPath = raw.backupPath

    if (
      typeof proposalId !== "string" ||
      proposalId !== expectedId ||
      !PROPOSAL_ID_PATTERN.test(expectedId)
    ) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent does not name its proposal file."),
      )
    }
    if (!isOperation(operation)) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent has an unknown operation."),
      )
    }
    if (typeof noteId !== "string" || !Markdown.isNoteId(noteId)) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent has an invalid note ID."),
      )
    }
    if (
      typeof targetPath !== "string" ||
      targetPath !== join(root, `${noteId}.md`)
    ) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent target is not the canonical note path."),
      )
    }
    if (phase !== "prepared" && phase !== "applied") {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent has an unknown phase."),
      )
    }
    if (
      typeof proposalHash !== "string" ||
      !HASH_PATTERN.test(proposalHash)
    ) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent proposal hash is malformed."),
      )
    }
    if (!isTimestamp(preparedAt)) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent preparation time is malformed."),
      )
    }
    if (baseHash !== undefined && (typeof baseHash !== "string" || !HASH_PATTERN.test(baseHash))) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent base hash is malformed."),
      )
    }
    if (operation !== "create" && typeof baseHash !== "string") {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent is missing its base hash."),
      )
    }
    if (appliedAt !== undefined && !isTimestamp(appliedAt)) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent application time is malformed."),
      )
    }
    if (resultHash !== undefined && (typeof resultHash !== "string" || !HASH_PATTERN.test(resultHash))) {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent result hash is malformed."),
      )
    }
    if (backupPath !== undefined && typeof backupPath !== "string") {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent backup path is malformed."),
      )
    }
    if (phase === "applied" && operation === "delete" && typeof backupPath !== "string") {
      return yield* Effect.fail(
        invalidIntent(path, "An applied delete intent is missing its backup path."),
      )
    }
    if (
      phase === "applied" &&
      operation !== "delete" &&
      typeof resultHash !== "string"
    ) {
      return yield* Effect.fail(
        invalidIntent(path, "An applied note intent is missing its result hash."),
      )
    }

    return {
      proposalId,
      operation,
      noteId,
      path: targetPath,
      phase,
      ...(baseHash === undefined ? {} : { baseHash }),
      proposalHash,
      preparedAt,
      ...(appliedAt === undefined ? {} : { appliedAt }),
      ...(resultHash === undefined ? {} : { resultHash }),
      ...(backupPath === undefined ? {} : { backupPath }),
    }
  })

const readIntentFile = (
  path: string,
  root: string,
  expectedId: string,
): Effect.Effect<ApplyIntent, ApprovalError> =>
  Effect.gen(function* () {
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(path)
    } catch (cause) {
      return yield* Effect.fail(
        approvalError({
          code: "apply-unknown",
          path,
          proposalId: expectedId,
          message: `Could not inspect the apply intent: ${
            cause instanceof Error ? cause.message : String(cause)
          }. No note was written by this attempt; inspect .state/${APPLY_INTENT_DIRECTORY} before retrying.`,
        }),
      )
    }
    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        invalidIntent(path, "Apply intent files must not be symbolic links."),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        invalidIntent(path, "An apply intent entry must be a regular file."),
      )
    }

    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        approvalError({
          code: "apply-unknown",
          path,
          proposalId: expectedId,
          message: `Could not read the apply intent: ${
            cause instanceof Error ? cause.message : String(cause)
          }. No note was written by this attempt; inspect .state/${APPLY_INTENT_DIRECTORY} before retrying.`,
        }),
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return yield* Effect.fail(
        invalidIntent(path, "The apply intent is not valid JSON."),
      )
    }

    return yield* decodeIntent(parsed, path, root, expectedId)
  })

const assertProposalId = (proposalId: string): Effect.Effect<void, ApprovalError> =>
  PROPOSAL_ID_PATTERN.test(proposalId)
    ? Effect.void
    : Effect.fail(
        approvalError({
          code: "invalid-proposal",
          proposalId,
          message: `'${proposalId}' is not a proposal ID.`,
        }),
      )

const fileFor = (directory: string, proposalId: string): string =>
  join(directory, `${proposalId}${INTENT_SUFFIX}`)

/**
 * Filesystem intent store under `.state/apply-intent/`.
 *
 * Every directory is created through `ensureStateSubdirectory`, so a symlinked
 * `.state/` or `.state/apply-intent/` fails closed instead of writing outside
 * the repository. Records are written with the shared atomic write helper.
 */
export const makeApplyIntentStore = (
  config: ApplyIntentStoreConfig,
): Effect.Effect<ApplyIntentStoreShape, ApprovalError> =>
  Effect.sync(() => {
    const root = config.root
    const directory = join(stateDirectory(root), APPLY_INTENT_DIRECTORY)

    const ensureDirectory = (
      code: "apply-failed" | "apply-unknown",
    ): Effect.Effect<void, ApprovalError> =>
      Effect.try({
        try: () => {
          ensureStateSubdirectory(root, APPLY_INTENT_DIRECTORY)
        },
        catch: (cause) =>
          stateFailure(directory, "create the apply-intent directory", cause, code),
      })

    const get = (
      proposalId: string,
    ): Effect.Effect<Option.Option<ApplyIntent>, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        yield* ensureDirectory("apply-unknown")
        const path = fileFor(directory, proposalId)
        if (!existsSync(path)) {
          return Option.none()
        }
        return Option.some(yield* readIntentFile(path, root, proposalId))
      })

    const put = (
      intent: ApplyIntent,
    ): Effect.Effect<ApplyIntent, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(intent.proposalId)
        yield* ensureDirectory("apply-failed")
        const path = fileFor(directory, intent.proposalId)
        yield* atomicWriteFile(path, `${JSON.stringify(intent, null, 2)}\n`, {
          overwrite: true,
          mode: 0o600,
        }).pipe(
          Effect.mapError((error) =>
            approvalError({
              code: "apply-failed",
              path,
              proposalId: intent.proposalId,
              message: `Could not record the durable apply intent: ${error.message} No note was written.`,
            }),
          ),
        )
        return intent
      })

    const remove = (
      proposalId: string,
    ): Effect.Effect<boolean, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        yield* ensureDirectory("apply-failed")
        const path = fileFor(directory, proposalId)
        if (!existsSync(path)) {
          return false
        }
        try {
          unlinkSync(path)
          return true
        } catch (cause) {
          return yield* Effect.fail(
            approvalError({
              code: "apply-failed",
              path,
              proposalId,
              message: `Could not remove the apply intent: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
          )
        }
      })

    return { get, put, remove }
  })
