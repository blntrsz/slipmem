import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Option, Schema } from "effect"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import { atomicWriteFile } from "../markdown/atomic.js"
import { stateDirectory } from "../markdown/root.js"
import { type ApprovalError, approvalError } from "./errors.js"

export const PENDING_DIRECTORY = "pending"
export const PENDING_SUFFIX = ".json"
export const DEFAULT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_PENDING_PROPOSALS = 200
export const MAX_PROPOSAL_SUMMARY_CHARS = 1000
export const MAX_PROPOSAL_ACTOR_CHARS = 200
/** Generator shape; the stored schema only requires a non-blank string. */
export const PROPOSAL_ID_PATTERN = /^proposal-\d{14}-[0-9a-f]{8}$/

export interface ProposalStoreConfig {
  readonly root: string
  /** Injectable clock in epoch milliseconds. */
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxPending?: number
}

export type ApprovalProposal = Markdown.ApprovalProposal

export interface ProposalScan {
  readonly proposals: ReadonlyArray<ApprovalProposal>
  readonly invalid: ReadonlyArray<ApprovalError>
}

export interface ProposalStoreShape {
  readonly root: string
  readonly directory: string
  readonly scan: () => Effect.Effect<ProposalScan, ApprovalError>
  readonly list: () => Effect.Effect<ReadonlyArray<ApprovalProposal>, ApprovalError>
  readonly get: (
    proposalId: string,
  ) => Effect.Effect<Option.Option<ApprovalProposal>, ApprovalError>
  readonly put: (
    proposal: ApprovalProposal,
  ) => Effect.Effect<ApprovalProposal, ApprovalError>
  readonly remove: (
    proposalId: string,
  ) => Effect.Effect<boolean, ApprovalError>
  readonly cleanupExpired: (
    nowMs?: number,
  ) => Effect.Effect<ReadonlyArray<string>, ApprovalError>
}

const invalid = (
  path: string,
  message: string,
  field?: string,
  proposalId?: string,
): ApprovalError =>
  approvalError({
    code: "invalid-proposal",
    path,
    message,
    ...(field === undefined ? {} : { field }),
    ...(proposalId === undefined ? {} : { proposalId }),
  })

const canonicalNotePath = (root: string, noteId: string): string =>
  join(root, `${noteId}.md`)

const compareProposals = (
  left: ApprovalProposal,
  right: ApprovalProposal,
): number =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)

/**
 * Validates a decoded proposal against the local store contract in addition to
 * the shared schema: the ID must be generator-shaped, the target must be the
 * canonical direct child for `noteId`, and the expiry must stay within the
 * configured TTL so a hand-edited file cannot become immortal.
 */
const validateProposal = (
  proposal: ApprovalProposal,
  config: Required<Pick<ProposalStoreConfig, "root" | "ttlMs">>,
): ApprovalError | null => {
  if (!PROPOSAL_ID_PATTERN.test(proposal.id)) {
    return invalid(
      config.root,
      `Proposal ID '${proposal.id}' is not a slipmem proposal ID.`,
      "id",
      proposal.id,
    )
  }

  if (proposal.path !== canonicalNotePath(config.root, proposal.noteId)) {
    return invalid(
      proposal.path,
      `Proposal target path must be the canonical note path for '${proposal.noteId}'.`,
      "path",
      proposal.id,
    )
  }

  const created = Date.parse(proposal.createdAt)
  const expires = Date.parse(proposal.expiresAt)
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    return invalid(
      proposal.path,
      "Proposal timestamps must be real UTC instants.",
      "expiresAt",
      proposal.id,
    )
  }
  if (expires - created > config.ttlMs) {
    return invalid(
      proposal.path,
      `Proposal expiry exceeds the ${Math.trunc(config.ttlMs / 86_400_000)}-day limit.`,
      "expiresAt",
      proposal.id,
    )
  }

  if (proposal.summary.length > MAX_PROPOSAL_SUMMARY_CHARS) {
    return invalid(
      proposal.path,
      `Proposal summary must be ${MAX_PROPOSAL_SUMMARY_CHARS} characters or fewer.`,
      "summary",
      proposal.id,
    )
  }

  if (
    proposal.actor !== undefined &&
    proposal.actor.length > MAX_PROPOSAL_ACTOR_CHARS
  ) {
    return invalid(
      proposal.path,
      `Proposal actor must be ${MAX_PROPOSAL_ACTOR_CHARS} characters or fewer.`,
      "actor",
      proposal.id,
    )
  }

  if (
    "content" in proposal &&
    Buffer.byteLength(proposal.content, "utf8") > Markdown.MAX_NOTE_FILE_BYTES
  ) {
    return invalid(
      proposal.path,
      `Proposal content must be ${Markdown.MAX_NOTE_FILE_BYTES} bytes or fewer.`,
      "content",
      proposal.id,
    )
  }

  return null
}

const decodeProposal = (
  raw: unknown,
  path: string,
  config: Required<Pick<ProposalStoreConfig, "root" | "ttlMs">>,
  expectedId?: string,
): Effect.Effect<ApprovalProposal, ApprovalError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(Markdown.ApprovalProposal)(
      raw,
    ).pipe(
      Effect.mapError((issue) =>
        invalid(
          path,
          `Proposal file does not match the approval schema: ${String(issue)}`,
          undefined,
          expectedId,
        ),
      ),
    )

    if (expectedId !== undefined && decoded.id !== expectedId) {
      return yield* Effect.fail(
        invalid(
          path,
          `Proposal file name '${expectedId}' does not match its ID '${decoded.id}'.`,
          "id",
          expectedId,
        ),
      )
    }

    const problem = validateProposal(decoded, config)
    if (problem !== null) {
      return yield* Effect.fail(problem)
    }

    return decoded
  })

const readProposalFile = (
  path: string,
  config: Required<Pick<ProposalStoreConfig, "root" | "ttlMs">>,
  expectedId?: string,
): Effect.Effect<ApprovalProposal, ApprovalError> =>
  Effect.gen(function* () {
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (cause) {
      return yield* Effect.fail(
        approvalError({
          code: "proposal-read-failed",
          path,
          message: `Could not read the proposal file: ${cause instanceof Error ? cause.message : String(cause)}`,
          ...(expectedId === undefined ? {} : { proposalId: expectedId }),
        }),
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return yield* Effect.fail(
        invalid(
          path,
          "Proposal file is not valid JSON. Remove or repair it before applying.",
          undefined,
          expectedId,
        ),
      )
    }

    return yield* decodeProposal(parsed, path, config, expectedId)
  })

const fileFor = (directory: string, proposalId: string): string =>
  join(directory, `${proposalId}${PENDING_SUFFIX}`)

const assertProposalId = (proposalId: string): Effect.Effect<void, ApprovalError> =>
  PROPOSAL_ID_PATTERN.test(proposalId)
    ? Effect.void
    : Effect.fail(
        approvalError({
          code: "invalid-proposal",
          proposalId,
          message: `'${proposalId}' is not a proposal ID. Expected proposal-<UTC timestamp>-<8 hex characters>.`,
        }),
      )

/**
 * Filesystem proposal store under `.slipmem/.state/pending/`.
 *
 * Records are one JSON file per proposal, written with the shared atomic
 * temp-file-plus-rename helper. Nothing here touches note files.
 */
export const makeProposalStore = (
  config: ProposalStoreConfig,
): Effect.Effect<ProposalStoreShape, ApprovalError> =>
  Effect.sync(() => {
    const root = config.root
    const now = config.now ?? Date.now
    const ttlMs = config.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS
    const maxPending = config.maxPending ?? MAX_PENDING_PROPOSALS
    const directory = join(stateDirectory(root), PENDING_DIRECTORY)
    const validationConfig = { root, ttlMs }

    const ensureDirectory = (): Effect.Effect<void, ApprovalError> =>
      Effect.try({
        try: () => {
          mkdirSync(directory, { recursive: true, mode: 0o700 })
        },
        catch: (cause) =>
          approvalError({
            code: "proposal-write-failed",
            path: directory,
            message: `Could not create the pending proposal directory: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })

    const scan = (): Effect.Effect<ProposalScan, ApprovalError> =>
      Effect.gen(function* () {
        yield* ensureDirectory()
        let names: ReadonlyArray<string>
        try {
          names = readdirSync(directory)
        } catch (cause) {
          return yield* Effect.fail(
            approvalError({
              code: "proposal-read-failed",
              path: directory,
              message: `Could not read the pending proposal directory: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
          )
        }

        const proposals: ApprovalProposal[] = []
        const invalidProposals: ApprovalError[] = []
        for (const name of [...names].sort()) {
          if (
            !name.endsWith(PENDING_SUFFIX) ||
            name.startsWith(".")
          ) {
            continue
          }
          const path = join(directory, name)
          const expectedId = name.slice(0, -PENDING_SUFFIX.length)
          const result = yield* readProposalFile(path, validationConfig, expectedId).pipe(
            Effect.match({
              onFailure: (error) => ({ error, proposal: null }),
              onSuccess: (proposal) => ({ error: null, proposal }),
            }),
          )
          if (result.error !== null) {
            invalidProposals.push(result.error)
          } else if (result.proposal !== null) {
            proposals.push(result.proposal)
          }
        }

        proposals.sort(compareProposals)
        return { proposals, invalid: invalidProposals }
      })

    const list = (): Effect.Effect<ReadonlyArray<ApprovalProposal>, ApprovalError> =>
      scan().pipe(Effect.map((result) => result.proposals))

    const get = (
      proposalId: string,
    ): Effect.Effect<Option.Option<ApprovalProposal>, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
        const path = fileFor(directory, proposalId)
        if (!existsSync(path)) {
          return Option.none()
        }
        return Option.some(yield* readProposalFile(path, validationConfig, proposalId))
      })

    const put = (
      proposal: ApprovalProposal,
    ): Effect.Effect<ApprovalProposal, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposal.id)
        const problem = validateProposal(proposal, validationConfig)
        if (problem !== null) {
          return yield* Effect.fail(problem)
        }

        yield* ensureDirectory()
        const current = yield* list()
        const nowIso = Markdown.toUtcTimestamp(now()).isoTimestamp
        const active = current.filter((item) => item.expiresAt >= nowIso)
        if (active.length >= maxPending) {
          return yield* Effect.fail(
            approvalError({
              code: "proposal-queue-full",
              path: directory,
              proposalId: proposal.id,
              message: `The pending approval queue already holds ${active.length} proposals (maximum ${maxPending}). Review or reject old proposals first.`,
            }),
          )
        }

        const path = fileFor(directory, proposal.id)
        if (existsSync(path)) {
          return yield* Effect.fail(
            approvalError({
              code: "proposal-id-conflict",
              path,
              proposalId: proposal.id,
              message: "A proposal with this ID already exists. Generate a new proposal ID.",
            }),
          )
        }

        yield* atomicWriteFile(path, `${JSON.stringify(proposal, null, 2)}\n`, {
          overwrite: false,
          mode: 0o600,
        }).pipe(
          Effect.mapError((error) =>
            approvalError({
              code: "proposal-write-failed",
              path,
              proposalId: proposal.id,
              message: `Could not store the pending proposal: ${error.message}`,
            }),
          ),
        )

        return proposal
      })

    const remove = (
      proposalId: string,
    ): Effect.Effect<boolean, ApprovalError> =>
      Effect.gen(function* () {
        yield* assertProposalId(proposalId)
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
              code: "proposal-write-failed",
              path,
              proposalId,
              message: `Could not remove the proposal: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
          )
        }
      })

    const cleanupExpired = (
      nowMs?: number,
    ): Effect.Effect<ReadonlyArray<string>, ApprovalError> =>
      Effect.gen(function* () {
        const current = yield* scan()
        const edge = Markdown.toUtcTimestamp(nowMs ?? now()).isoTimestamp
        const removed: string[] = []
        for (const proposal of current.proposals) {
          if (proposal.expiresAt >= edge) {
            continue
          }
          const path = fileFor(directory, proposal.id)
          try {
            unlinkSync(path)
            removed.push(proposal.id)
          } catch {
            // A concurrent reviewer removed it first; that is still success.
          }
        }
        return removed
      })

    return { root, directory, scan, list, get, put, remove, cleanupExpired }
  })
