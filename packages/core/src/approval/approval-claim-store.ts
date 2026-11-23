import { Effect, Option, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { atomicWriteFile } from "../markdown/atomic.js"
import { MarkdownError } from "../markdown/errors.js"
import { ensureStateSubdirectory, stateDirectory } from "../markdown/root.js"
import { type ApprovalError, approvalError } from "./errors.js"
import { PROPOSAL_ID_PATTERN } from "./proposal-store.js"

/**
 * A per-proposal terminal-decision claim.
 *
 * Apply and reject are both terminal human decisions. Without a claim, reject
 * can remove the proposal while apply already holds it in memory, and both
 * calls can report success. The claim is written before either decision reads
 * or mutates the proposal:
 *
 * - the first decision wins;
 * - a later opposite decision fails closed instead of reporting a terminal
 *   outcome it did not perform;
 * - a retry of the same decision is allowed so apply-intent reconciliation can
 *   finish after a crash.
 *
 * A process-local semaphore serializes same-process calls; the claim file is
 * the cross-process fence. Claims are small local state and are removed only
 * after the proposal and apply intent are cleaned up.
 */
export const APPROVAL_CLAIM_DIRECTORY = "approval-claim"
const CLAIM_SUFFIX = ".json"

export type ApprovalDecision = "apply" | "reject"

export interface ApprovalClaim {
  readonly proposalId: string
  readonly decision: ApprovalDecision
  readonly token: string
  readonly pid: number
  readonly createdAt: string
}

export type ApprovalClaimResult =
  | { readonly status: "claimed"; readonly claim: ApprovalClaim }
  | { readonly status: "existing"; readonly claim: ApprovalClaim }

export interface ApprovalClaimStoreShape {
  readonly get: (
    proposalId: string,
  ) => Effect.Effect<Option.Option<ApprovalClaim>, ApprovalError>
  readonly claim: (
    proposalId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<ApprovalClaimResult, ApprovalError>
  readonly remove: (proposalId: string) => Effect.Effect<boolean, ApprovalError>
}

export interface ApprovalClaimStoreConfig {
  readonly root: string
  readonly now?: () => number
}

/**
 * A claim is live while its owner process exists. Cleanup must not remove the
 * claim or intent of a live apply that is still in flight, even after the
 * proposal expires.
 */
export const approvalClaimOwnerIsAlive = (claim: ApprovalClaim): boolean => {
  try {
    process.kill(claim.pid, 0)
    return true
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EPERM"
    )
  }
}

const decisionSemaphores = new Map<string, Semaphore.Semaphore>()

const decisionSemaphoreFor = (
  root: string,
  proposalId: string,
): Semaphore.Semaphore => {
  const key = `${resolve(root)}\0${proposalId}`
  const existing = decisionSemaphores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const semaphore = Semaphore.makeUnsafe(1)
  decisionSemaphores.set(key, semaphore)
  return semaphore
}

/**
 * Serializes apply/reject for one proposal in this process. The claim file
 * covers other processes; this only avoids needless claim collisions and
 * makes the test-visible ordering deterministic.
 */
export const withApprovalDecisionLock = <A, E, R>(
  root: string,
  proposalId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  decisionSemaphoreFor(root, proposalId).withPermits(1)(effect)

const claimError = (
  path: string,
  proposalId: string,
  action: string,
  cause: unknown,
): ApprovalError =>
  approvalError({
    code: "proposal-write-failed",
    path: cause instanceof MarkdownError ? cause.path : path,
    proposalId,
    message: `Could not ${action}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  })

const readError = (
  path: string,
  proposalId: string,
  message: string,
): ApprovalError =>
  approvalError({
    code: "proposal-read-failed",
    path,
    proposalId,
    message,
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
  join(directory, `${proposalId}${CLAIM_SUFFIX}`)

const pathOccupied = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isDecision = (value: unknown): value is ApprovalDecision =>
  value === "apply" || value === "reject"

const decodeClaim = (
  raw: unknown,
  path: string,
  expectedId: string,
): Effect.Effect<ApprovalClaim, ApprovalError> =>
  Effect.gen(function* () {
    if (!isRecord(raw)) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim is not a JSON object."),
      )
    }
    if (
      typeof raw.proposalId !== "string" ||
      raw.proposalId !== expectedId ||
      !PROPOSAL_ID_PATTERN.test(expectedId)
    ) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim does not name its proposal file."),
      )
    }
    if (!isDecision(raw.decision)) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim has an unknown decision."),
      )
    }
    if (typeof raw.token !== "string" || raw.token.trim().length === 0) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim token is malformed."),
      )
    }
    if (
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0
    ) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim process ID is malformed."),
      )
    }
    if (
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt))
    ) {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim creation time is malformed."),
      )
    }
    return {
      proposalId: raw.proposalId,
      decision: raw.decision,
      token: raw.token,
      pid: raw.pid,
      createdAt: raw.createdAt,
    }
  })

const readClaimFile = (
  path: string,
  expectedId: string,
): Effect.Effect<ApprovalClaim, ApprovalError> =>
  Effect.gen(function* () {
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(path)
    } catch (cause) {
      return yield* Effect.fail(
        readError(
          path,
          expectedId,
          `Could not inspect the approval claim: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      )
    }
    if (stats.isSymbolicLink()) {
      return yield* Effect.fail(
        readError(path, expectedId, "Approval claim files must not be symbolic links."),
      )
    }
    if (!stats.isFile()) {
      return yield* Effect.fail(
        readError(path, expectedId, "An approval claim entry must be a regular file."),
      )
    }

    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        readError(
          path,
          expectedId,
          `Could not read the approval claim: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return yield* Effect.fail(
        readError(path, expectedId, "The approval claim is not valid JSON."),
      )
    }

    return yield* decodeClaim(parsed, path, expectedId)
  })

/**
 * Filesystem claim store under `.state/approval-claim/`. Every directory is
 * created through `ensureStateSubdirectory`, and claim files reject symlinks so
 * a linked local-state entry cannot redirect the decision fence.
 */
export const makeApprovalClaimStore = (
  config: ApprovalClaimStoreConfig,
): Effect.Effect<ApprovalClaimStoreShape, ApprovalError> =>
  Effect.sync(() => {
    const root = config.root
    const now = config.now ?? Date.now
    const directory = join(stateDirectory(root), APPROVAL_CLAIM_DIRECTORY)

    const ensureDirectory = (): Effect.Effect<void, ApprovalError> =>
      Effect.try({
        try: () => {
          ensureStateSubdirectory(root, APPROVAL_CLAIM_DIRECTORY)
        },
        catch: (cause) =>
          claimError(
            directory,
            "",
            "create the approval claim directory",
            cause,
          ),
      })

    const get = (
      proposalId: string,
    ): Effect.Effect<Option.Option<ApprovalClaim>, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        yield* ensureDirectory()
        const path = fileFor(directory, proposalId)
        if (!pathOccupied(path)) {
          return Option.none()
        }
        return Option.some(yield* readClaimFile(path, proposalId))
      })

    const claim = (
      proposalId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<ApprovalClaimResult, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        yield* ensureDirectory()
        const path = fileFor(directory, proposalId)
        if (pathOccupied(path)) {
          return {
            status: "existing" as const,
            claim: yield* readClaimFile(path, proposalId),
          }
        }

        const next: ApprovalClaim = {
          proposalId,
          decision,
          token: randomUUID(),
          pid: process.pid,
          createdAt: new Date(now()).toISOString(),
        }
        const write = yield* atomicWriteFile(
          path,
          `${JSON.stringify(next, null, 2)}\n`,
          { overwrite: false, mode: 0o600 },
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ error, claim: null }),
            onSuccess: () => ({ error: null, claim: next }),
          }),
        )
        if (write.claim !== null) {
          return { status: "claimed" as const, claim: write.claim }
        }
        if (pathOccupied(path)) {
          return {
            status: "existing" as const,
            claim: yield* readClaimFile(path, proposalId),
          }
        }
        return yield* Effect.fail(
          claimError(path, proposalId, "record the approval claim", write.error),
        )
      })

    const remove = (
      proposalId: string,
    ): Effect.Effect<boolean, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        yield* ensureDirectory()
        const path = fileFor(directory, proposalId)
        if (!existsSync(path)) {
          return false
        }
        try {
          unlinkSync(path)
          return true
        } catch (cause) {
          return yield* Effect.fail(
            claimError(path, proposalId, "remove the approval claim", cause),
          )
        }
      })

    return { get, claim, remove }
  })
