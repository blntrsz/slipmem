import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer, Option } from "effect"
import { createHash, randomBytes } from "node:crypto"
import type { MarkdownError } from "../markdown/errors.js"
import { parseMarkdownNote, type ParsedMarkdownNote } from "../markdown/note-document.js"
import { renderNoteDocument } from "../markdown/frontmatter.js"
import { notePath } from "../markdown/paths.js"
import {
  MarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  approvalClaimOwnerIsAlive,
  makeApprovalClaimStore,
  withApprovalDecisionLock,
  type ApprovalClaimStoreShape,
} from "./approval-claim-store.js"
import {
  makeApplyIntentStore,
  type ApplyIntent,
  type ApplyIntentStoreShape,
} from "./apply-intent-store.js"
import { proposalDiff } from "./diff.js"
import { type ApprovalError, approvalError } from "./errors.js"
import {
  decidePolicy,
  mcpProvenance,
  resolveMcpWritePolicy,
  type McpWritePolicy,
} from "./policy.js"
import {
  DEFAULT_PROPOSAL_TTL_MS,
  MAX_PENDING_PROPOSALS,
  PROPOSAL_ID_PATTERN,
  makeProposalStore,
  type ApprovalProposal,
  type ProposalStoreShape,
} from "./proposal-store.js"

/** Only the repository operations approval and review need. */
export type ApprovalRepository = Pick<
  MarkdownNoteRepositoryShape,
  "root" | "scan" | "get" | "create" | "update" | "delete"
>

export const MAX_ACTOR_LENGTH = 200

export interface ApprovalServiceConfig {
  readonly now?: () => number
  /** Default actor, normally `SLIPMEM_ACTOR`. Metadata, not authentication. */
  readonly actor?: string
  readonly mcpWritePolicy?: McpWritePolicy
  /** Passed to `resolveMcpWritePolicy` when no explicit policy is set. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly ttlMs?: number
  readonly maxPending?: number
  /** Injectable for tests; otherwise a filesystem store is created. */
  readonly store?: ProposalStoreShape
  /** Injectable for tests; otherwise a filesystem intent store is created. */
  readonly intentStore?: ApplyIntentStoreShape
  /** Injectable for tests; otherwise a filesystem claim store is created. */
  readonly claimStore?: ApprovalClaimStoreShape
  /**
   * Refreshes the disposable search index after a durable approval. Failures
   * never roll back or hide the note change; they are reported on the applied
   * result as an actionable recovery warning.
   */
  readonly refreshIndex?: () => Effect.Effect<void, MarkdownError>
}

export interface McpCreateInput {
  readonly operation: "create"
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly tags?: ReadonlyArray<string>
  readonly actor?: string
}

export interface McpUpdateInput {
  readonly operation: "update"
  readonly id: string
  readonly type?: Markdown.NoteType
  readonly title?: string
  readonly content?: string
  /** `null` removes the reference; `undefined` preserves it. */
  readonly reference?: string | null
  readonly tags?: ReadonlyArray<string>
  readonly actor?: string
}

export interface McpDeleteInput {
  readonly operation: "delete"
  readonly id: string
  readonly actor?: string
}

export type McpWriteInput = McpCreateInput | McpUpdateInput | McpDeleteInput

export type McpWriteResult =
  | {
      readonly status: "direct"
      readonly note: ParsedMarkdownNote
      readonly unsafeDirect: boolean
    }
  | {
      readonly status: "pending_approval"
      readonly proposalId: string
      readonly summary: string
    }

export interface ApprovalReviewItem {
  readonly proposal: ApprovalProposal
  readonly summary: string
  readonly diff: string
  /** `true` when the base hash or target existence no longer matches. */
  readonly stale: boolean
  readonly expired: boolean
  readonly currentHash: string | null
}

export interface ApprovalReviewReport {
  readonly proposals: ReadonlyArray<ApprovalReviewItem>
  /** Proposal files that failed schema/path validation. Not applied. */
  readonly invalid: ReadonlyArray<ApprovalError>
  /** Expired proposals removed by this review, if cleanup was enabled. */
  readonly removed: ReadonlyArray<string>
  /** Old malformed proposal files moved to bounded local quarantine. */
  readonly quarantined: ReadonlyArray<string>
}

/**
 * Outcome of the post-approval derived-index refresh.
 *
 * `skipped` means the service was built without a refresh dependency. The note
 * change is already durable in every case; `failed` only describes the
 * disposable cache and carries a recovery instruction.
 */
export interface ApprovalIndexRefresh {
  readonly status: "refreshed" | "failed" | "skipped"
  readonly warning?: string
}

/**
 * Cleanup is deliberately separate from the verified note mutation. The note
 * is durable before cleanup starts; a leftover proposal or intent is reported
 * as a retryable warning instead of turning a successful apply into a failure.
 */
export interface ApprovalCleanup {
  readonly status: "pending"
  readonly warning: string
}

export type ApprovalApplication =
  | {
      readonly status: "applied"
      readonly proposalId: string
      readonly operation: "create" | "update" | "reclassify"
      readonly noteId: string
      readonly note: ParsedMarkdownNote
      readonly index: ApprovalIndexRefresh
      /** Present only when a durable note change still has local cleanup to retry. */
      readonly cleanup?: ApprovalCleanup
    }
  | {
      readonly status: "applied"
      readonly proposalId: string
      readonly operation: "delete"
      readonly noteId: string
      readonly backupPath: string
      readonly index: ApprovalIndexRefresh
      /** Present only when a durable note change still has local cleanup to retry. */
      readonly cleanup?: ApprovalCleanup
    }

export interface ApprovalRejection {
  readonly status: "rejected"
  readonly proposalId: string
}

export interface ApprovalServiceShape {
  readonly root: string
  readonly policy: McpWritePolicy
  /** Policy-enforced MCP entry point. Never applies a pending proposal. */
  readonly submitMcp: (
    input: McpWriteInput,
  ) => Effect.Effect<McpWriteResult, ApprovalError>
  /**
   * Human review surface. Returns summaries and diffs, cleans up expired
   * proposals by default, and reports tampered proposal files without applying
   * them. This method must not be exposed as an MCP tool.
   */
  readonly review: (options?: {
    readonly cleanupExpired?: boolean
  }) => Effect.Effect<ApprovalReviewReport, ApprovalError>
  /** Human apply surface. Revalidates expiry, base hash, and note rules. */
  readonly apply: (
    proposalId: string,
  ) => Effect.Effect<ApprovalApplication, ApprovalError>
  /** Human reject surface. Removes the proposal and changes no note. */
  readonly reject: (
    proposalId: string,
  ) => Effect.Effect<ApprovalRejection, ApprovalError>
  readonly cleanupExpired: (
    nowMs?: number,
  ) => Effect.Effect<ReadonlyArray<string>, ApprovalError>
}

export class ApprovalService extends Context.Service<
  ApprovalService,
  ApprovalServiceShape
>()("@slipmem/core/ApprovalService") {}

const repositoryFailure = (
  action: string,
  error: { readonly message: string; readonly path?: string },
): ApprovalError =>
  approvalError({
    code: "repository-failure",
    path: error.path,
    message: `Could not ${action}: ${error.message}`,
  })

/**
 * Maps the repository's under-lock compare-and-swap failure to the approval
 * stale-base contract. The repository check is the authoritative one: a writer
 * can land between an earlier `review`/`apply` read and the actual mutation.
 */
const applyRepositoryFailure = (
  action: string,
  proposal: { readonly id: string; readonly noteId: string },
  error: { readonly code: string; readonly message: string; readonly path?: string },
): ApprovalError =>
  error.code === "stale-base"
    ? approvalError({
        code: "stale-base",
        proposalId: proposal.id,
        noteId: proposal.noteId,
        path: error.path,
        message:
          "The note changed after this proposal was created, so its base hash no longer matches. Nothing was written; ask the agent to propose again from the current note.",
      })
    : repositoryFailure(action, error)

const invalidRequest = (
  message: string,
  field?: string,
  noteId?: string,
): ApprovalError =>
  approvalError({
    code: "policy-invalid",
    message,
    ...(field === undefined ? {} : { field }),
    ...(noteId === undefined ? {} : { noteId }),
  })

const normalizeActor = (
  value: string | undefined,
): Effect.Effect<string | undefined, ApprovalError> =>
  Effect.gen(function* () {
    if (value === undefined) {
      return undefined
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      return undefined
    }
    if (trimmed.length > MAX_ACTOR_LENGTH) {
      return yield* Effect.fail(
        invalidRequest(
          `Actor must be ${MAX_ACTOR_LENGTH} characters or fewer.`,
          "actor",
        ),
      )
    }
    return trimmed
  })

const normalizeTags = (
  tags: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, ApprovalError> =>
  Effect.gen(function* () {
    if (tags === undefined) {
      return undefined
    }
    const normalized: string[] = []
    for (const tag of tags) {
      const slug = Markdown.slugifyTag(tag)
      if (slug === "") {
        return yield* Effect.fail(
          invalidRequest(
            `Tag '${tag}' does not normalize to a usable slug.`,
            "tags",
          ),
        )
      }
      if (!normalized.includes(slug)) {
        normalized.push(slug)
      }
    }
    return normalized
  })

const normalizeReference = (reference: string | undefined): string | undefined => {
  if (reference === undefined) {
    return undefined
  }
  const trimmed = reference.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const titleOf = (note: ParsedMarkdownNote): string => note.metadata.title

const newProposalId = (nowMs: number): string => {
  const stamp = Markdown.toUtcTimestamp(nowMs).filenamePrefix
  return `proposal-${stamp}-${randomBytes(4).toString("hex")}`
}

const summaryFor = (
  operation: Markdown.ApprovalOperation,
  type: Markdown.NoteType | undefined,
  title: string,
): string => {
  const quoted = `"${title}"`
  switch (operation) {
    case "create":
      return `Create ${type ?? "note"} note ${quoted}.`
    case "update":
      return `Update ${type ?? "note"} note ${quoted}.`
    case "reclassify":
      return `Reclassify note ${quoted}${type === undefined ? "" : ` to ${type}`}.`
    case "delete":
      return `Delete ${type ?? "note"} note ${quoted}.`
  }
}

const buildDocument = (input: {
  readonly path: string
  readonly metadata: Markdown.NoteMetadata
  readonly body: string
  readonly unknown?: Readonly<Record<string, unknown>>
}): Effect.Effect<{ readonly content: string; readonly parsed: ParsedMarkdownNote }, ApprovalError> =>
  Effect.gen(function* () {
    const content = renderNoteDocument({
      metadata: input.metadata,
      body: input.body,
      unknown: input.unknown ?? {},
    })
    const parsed = yield* parseMarkdownNote({ path: input.path, content }).pipe(
      Effect.mapError((error) =>
        approvalError({
          code: "policy-invalid",
          path: input.path,
          field: error.field,
          message: `The proposed note is invalid: ${error.message}`,
        }),
      ),
    )
    return { content, parsed }
  })

const contentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

/**
 * Identifies the proposal payload an apply intent was prepared from. A
 * hand-edited or replaced proposal file must not inherit an older intent.
 */
const proposalFingerprint = (proposal: ApprovalProposal): string =>
  contentHash(
    JSON.stringify({
      operation: proposal.operation,
      noteId: proposal.noteId,
      path: proposal.path,
      baseHash: proposal.baseHash ?? null,
      content: "content" in proposal ? proposal.content : null,
    }),
  )

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    )
  }
  return value
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))

const sameStringList = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean => sameValue(left ?? [], right ?? [])

/**
 * Semantic comparison used to verify a create/update result after a crash.
 * `updatedAt` is ignored for updates because the repository stamps its own
 * clock; every other proposed field must match the file on disk.
 */
const noteMatchesProposal = (
  note: ParsedMarkdownNote,
  proposed: ParsedMarkdownNote,
  includeUpdatedAt: boolean,
): boolean =>
  note.id === proposed.id &&
  note.body === proposed.body &&
  note.metadata.type === proposed.metadata.type &&
  note.metadata.title === proposed.metadata.title &&
  note.metadata.createdAt === proposed.metadata.createdAt &&
  (!includeUpdatedAt || note.metadata.updatedAt === proposed.metadata.updatedAt) &&
  sameStringList(note.metadata.tags, proposed.metadata.tags) &&
  note.metadata.reference === proposed.metadata.reference &&
  sameValue(note.metadata.provenance, proposed.metadata.provenance) &&
  note.metadata.legacyId === proposed.metadata.legacyId &&
  sameStringList(note.metadata.aliases, proposed.metadata.aliases) &&
  sameValue(note.unknown, proposed.unknown)

type IntentVerification =
  | { readonly status: "not-applied" }
  | {
      readonly status: "applied"
      readonly note: ParsedMarkdownNote | null
      readonly backupPath?: string
    }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "unknown"; readonly message: string }

interface ApplyProgress {
  /**
   * True once this or an earlier attempt may have changed the note. A failed
   * apply with a possibly-durable write must keep its decision claim so a
   * concurrent reject cannot report `rejected` over an applied note.
   */
  mayHaveWritten: boolean
  /** Whether this call created the claim (and may safely release it). */
  claimCreated: boolean
}

/**
 * Only `write-failed` is ambiguous after a mutation call. Every other
 * repository failure (stale-base, target-exists, not-found, validation,
 * backup-failed) happens before the note file is changed.
 */
const repositoryErrorMayHaveWritten = (code: string): boolean =>
  code === "write-failed"

type AppliedPayload =
  | {
      readonly status: "applied"
      readonly proposalId: string
      readonly operation: "create" | "update" | "reclassify"
      readonly noteId: string
      readonly note: ParsedMarkdownNote
    }
  | {
      readonly status: "applied"
      readonly proposalId: string
      readonly operation: "delete"
      readonly noteId: string
      readonly backupPath: string
    }

const applyConflict = (
  proposal: { readonly id: string; readonly noteId: string; readonly path: string },
  message: string,
): ApprovalError =>
  approvalError({
    code: "apply-conflict",
    proposalId: proposal.id,
    noteId: proposal.noteId,
    path: proposal.path,
    message,
  })

const applyUnknown = (
  proposal: { readonly id: string; readonly noteId: string; readonly path: string },
  message: string,
): ApprovalError =>
  approvalError({
    code: "apply-unknown",
    proposalId: proposal.id,
    noteId: proposal.noteId,
    path: proposal.path,
    message,
  })

const applyCreateRepositoryFailure = (
  proposal: { readonly id: string; readonly noteId: string; readonly path: string },
  error: { readonly code: string; readonly message: string; readonly path?: string },
): ApprovalError =>
  error.code === "target-exists"
    ? approvalError({
        code: "target-exists",
        proposalId: proposal.id,
        noteId: proposal.noteId,
        path: error.path ?? proposal.path,
        message:
          "A note with this ID was created after the proposal was reviewed. The exact-ID create did not rename or replace it; nothing was written. Reject the proposal and ask the agent to propose again.",
      })
    : repositoryFailure("apply the create proposal", error)

/**
 * Builds the approval service for one repository.
 *
 * The service owns proposal creation, human review/apply/reject, TTL cleanup,
 * and the MCP write policy. It only uses the repository's scan/get/create/
 * update/delete methods; all note writes keep the repository's atomic write and
 * lock behavior. Applying a proposal stamps a fresh `updatedAt` through the
 * repository, so the applied file is not byte-identical to the proposed preview,
 * but every proposed field is revalidated first. A configured `refreshIndex`
 * runs after each durable create/update/delete; its failure is reported as a
 * warning on the applied result rather than undoing the note.
 *
 * Before mutating a note, apply durably records an intent under
 * `.state/apply-intent/`. If the process or proposal cleanup fails after the
 * note change, a retry verifies the note against the intent and returns the
 * same applied result instead of reporting a stale base or overwriting it.
 */
export const makeApprovalService = (
  repository: ApprovalRepository,
  config: ApprovalServiceConfig = {},
): Effect.Effect<ApprovalServiceShape, ApprovalError> =>
  Effect.gen(function* () {
    const now = config.now ?? Date.now
    const ttlMs = config.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS
    const maxPending = config.maxPending ?? MAX_PENDING_PROPOSALS
    const resolvedPolicy =
      config.mcpWritePolicy === undefined
        ? resolveMcpWritePolicy(config.env ?? process.env)
        : { policy: config.mcpWritePolicy }
    const policy = resolvedPolicy.policy
    const defaultActor = yield* normalizeActor(config.actor)

    const store =
      config.store ??
      (yield* makeProposalStore({
        root: repository.root,
        now,
        ttlMs,
        maxPending,
      }))

    const intentStore =
      config.intentStore ??
      (yield* makeApplyIntentStore({ root: repository.root }))

    const claimStore =
      config.claimStore ??
      (yield* makeApprovalClaimStore({ root: repository.root, now }))

    const readNote = (
      id: string,
    ): Effect.Effect<ParsedMarkdownNote | null, ApprovalError> =>
      repository.get(id).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError((error) => repositoryFailure(`read note '${id}'`, error)),
      )

    /**
     * Runs only after the repository has durably written or deleted the note.
     * A cache failure is mapped to a warning instead of a typed failure so the
     * approval result and the proposal cleanup still reflect the real note
     * state. The index is disposable; the Markdown file remains the truth.
     */
    const refreshDerivedIndex = (): Effect.Effect<ApprovalIndexRefresh> => {
      const refresh = config.refreshIndex
      if (refresh === undefined) {
        return Effect.succeed({ status: "skipped" })
      }
      return refresh().pipe(
        Effect.as({ status: "refreshed" } as const),
        Effect.catch((error) =>
          Effect.succeed({
            status: "failed" as const,
            warning: `The note is durable, but the derived search index could not be refreshed: ${error.message} Run 'slipmem check --rebuild-index' to recover the cache.`,
          }),
        ),
      )
    }

    const putProposal = (
      build: (proposalId: string, nowMs: number) => Effect.Effect<
        ApprovalProposal,
        ApprovalError
      >,
    ): Effect.Effect<ApprovalProposal, ApprovalError> =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 3; attempt++) {
          const nowMs = now()
          const proposal = yield* build(newProposalId(nowMs), nowMs)
          const result = yield* store.put(proposal).pipe(
            Effect.match({
              onFailure: (error) => ({ error, proposal: null }),
              onSuccess: (value) => ({ error: null, proposal: value }),
            }),
          )
          if (result.proposal !== null) {
            return result.proposal
          }
          if (result.error.code !== "proposal-id-conflict") {
            return yield* Effect.fail(result.error)
          }
        }
        return yield* Effect.fail(
          approvalError({
            code: "proposal-id-conflict",
            message: "Could not allocate a unique proposal ID after three attempts. Retry.",
          }),
        )
      })

    const submitCreate = (
      input: McpCreateInput,
    ): Effect.Effect<McpWriteResult, ApprovalError> =>
      Effect.gen(function* () {
        const actor = yield* normalizeActor(input.actor ?? defaultActor)
        const tags = yield* normalizeTags(input.tags)
        const reference = normalizeReference(input.reference)
        const decision = decidePolicy({
          caller: "mcp",
          operation: "create",
          nextType: input.type,
          mcpWritePolicy: policy,
        })

        if (decision.disposition === "direct") {
          const created = yield* repository
            .create({
              type: input.type,
              title: input.title,
              content: input.content,
              ...(tags === undefined ? {} : { tags }),
              ...(reference === undefined ? {} : { reference }),
              provenance: mcpProvenance(actor, decision.unsafeDirect),
            })
            .pipe(
              Effect.mapError((error) =>
                repositoryFailure("create the note", error),
              ),
            )
          return { status: "direct", note: created, unsafeDirect: decision.unsafeDirect }
        }

        const nowMs = now()
        const stamp = Markdown.toUtcTimestamp(nowMs)
        const scan = yield* repository
          .scan()
          .pipe(Effect.mapError((error) => repositoryFailure("scan the note root", error)))
        const pending = yield* store.list()
        const taken = new Set([
          ...scan.notes.map((note) => note.filename),
          ...pending
            .filter((item) => item.operation === "create")
            .map((item) => `${item.noteId}.md`),
        ])
        const filename = Markdown.noteFilename({
          title: input.title,
          taken,
        })
        const noteId = Markdown.noteIdFromFilename(filename)
        if (noteId === null) {
          return yield* Effect.fail(
            invalidRequest("Could not derive a note ID for the proposal.", "title"),
          )
        }
        const path = yield* notePath(repository.root, noteId).pipe(
          Effect.mapError((error) => repositoryFailure("resolve the proposal path", error)),
        )
        const metadata: Markdown.NoteMetadata = {
          schema: Markdown.SCHEMA_VERSION,
          id: noteId,
          type: input.type,
          title: input.title.trim(),
          createdAt: stamp.isoTimestamp,
          updatedAt: stamp.isoTimestamp,
          ...(tags === undefined || tags.length === 0 ? {} : { tags }),
          ...(reference === undefined ? {} : { reference }),
          provenance: mcpProvenance(actor, false),
        }

        const document = yield* buildDocument({
          path,
          metadata,
          body: input.content,
        })
        const summary = summaryFor("create", input.type, document.parsed.metadata.title)
        const proposal = yield* putProposal((proposalId) =>
          Effect.succeed({
            id: proposalId,
            createdAt: stamp.isoTimestamp,
            expiresAt: Markdown.toUtcTimestamp(nowMs + ttlMs).isoTimestamp,
            operation: "create",
            noteId,
            path,
            source: "mcp",
            ...(actor === undefined ? {} : { actor }),
            summary,
            content: document.content,
          }),
        )

        return {
          status: "pending_approval",
          proposalId: proposal.id,
          summary: proposal.summary,
        }
      })

    const submitUpdate = (
      input: McpUpdateInput,
    ): Effect.Effect<McpWriteResult, ApprovalError> =>
      Effect.gen(function* () {
        const actor = yield* normalizeActor(input.actor ?? defaultActor)
        const current = yield* readNote(input.id)
        if (current === null) {
          return yield* Effect.fail(
            approvalError({
              code: "target-missing",
              noteId: input.id,
              message: `Note '${input.id}' was not found.`,
            }),
          )
        }

        const nextType = input.type ?? current.metadata.type
        const isReclassify = nextType !== current.metadata.type
        const operation: Markdown.ApprovalOperation = isReclassify
          ? "reclassify"
          : "update"
        const decision = decidePolicy({
          caller: "mcp",
          operation,
          currentType: current.metadata.type,
          nextType,
          mcpWritePolicy: policy,
        })
        const tags = yield* normalizeTags(input.tags)
        const reference =
          input.reference === null
            ? null
            : input.reference === undefined
              ? current.metadata.reference
              : normalizeReference(input.reference)

        if (decision.disposition === "direct") {
          const updated = yield* repository
            .update({
              id: input.id,
              type: nextType,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.content === undefined ? {} : { content: input.content }),
              ...(tags === undefined ? {} : { tags }),
              ...(reference === null
                ? { reference: null }
                : reference === undefined
                  ? {}
                  : { reference }),
              provenance: mcpProvenance(actor, decision.unsafeDirect),
            })
            .pipe(
              Effect.mapError((error) => repositoryFailure("update the note", error)),
            )
          return { status: "direct", note: updated, unsafeDirect: decision.unsafeDirect }
        }

        const nowMs = now()
        const stamp = Markdown.toUtcTimestamp(nowMs)
        const metadata: Markdown.NoteMetadata = {
          ...current.metadata,
          type: nextType,
          title: input.title === undefined ? current.metadata.title : input.title.trim(),
          updatedAt: stamp.isoTimestamp,
          ...(tags === undefined
            ? {}
            : tags.length === 0
              ? { tags: undefined }
              : { tags }),
          ...(reference === null
            ? { reference: undefined }
            : reference === undefined
              ? {}
              : { reference }),
          provenance: mcpProvenance(actor, false),
        }

        const document = yield* buildDocument({
          path: current.path,
          metadata,
          body: input.content === undefined ? current.body : input.content,
          unknown: current.unknown,
        })
        const summary = summaryFor(operation, nextType, document.parsed.metadata.title)
        const proposal = yield* putProposal((proposalId) =>
          Effect.succeed({
            id: proposalId,
            createdAt: stamp.isoTimestamp,
            expiresAt: Markdown.toUtcTimestamp(nowMs + ttlMs).isoTimestamp,
            operation,
            noteId: current.id,
            path: current.path,
            source: "mcp",
            ...(actor === undefined ? {} : { actor }),
            summary,
            baseHash: current.contentHash,
            content: document.content,
          }),
        )

        return {
          status: "pending_approval",
          proposalId: proposal.id,
          summary: proposal.summary,
        }
      })

    const submitDelete = (
      input: McpDeleteInput,
    ): Effect.Effect<McpWriteResult, ApprovalError> =>
      Effect.gen(function* () {
        const actor = yield* normalizeActor(input.actor ?? defaultActor)
        const current = yield* readNote(input.id)
        if (current === null) {
          return yield* Effect.fail(
            approvalError({
              code: "target-missing",
              noteId: input.id,
              message: `Note '${input.id}' was not found.`,
            }),
          )
        }

        const nowMs = now()
        const stamp = Markdown.toUtcTimestamp(nowMs)
        const summary = summaryFor("delete", current.metadata.type, titleOf(current))
        const proposal = yield* putProposal((proposalId) =>
          Effect.succeed({
            id: proposalId,
            createdAt: stamp.isoTimestamp,
            expiresAt: Markdown.toUtcTimestamp(nowMs + ttlMs).isoTimestamp,
            operation: "delete",
            noteId: current.id,
            path: current.path,
            source: "mcp",
            ...(actor === undefined ? {} : { actor }),
            summary,
            baseHash: current.contentHash,
          }),
        )

        return {
          status: "pending_approval",
          proposalId: proposal.id,
          summary: proposal.summary,
        }
      })

    const submitMcp = (
      input: McpWriteInput,
    ): Effect.Effect<McpWriteResult, ApprovalError> => {
      switch (input.operation) {
        case "create":
          return submitCreate(input)
        case "update":
          return submitUpdate(input)
        case "delete":
          return submitDelete(input)
      }
    }

    const review = (
      options: { readonly cleanupExpired?: boolean } = {},
    ): Effect.Effect<ApprovalReviewReport, ApprovalError> =>
      Effect.gen(function* () {
        const cleanup =
          options.cleanupExpired === false
            ? { removed: [], quarantined: [] }
            : yield* store.cleanupExpired(now())
        const removed = cleanup.removed
        const quarantined = cleanup.quarantined
        const edge = Markdown.toUtcTimestamp(now()).isoTimestamp
        const scan = yield* store.scan()
        const proposals: ApprovalReviewItem[] = []

        for (const proposal of scan.proposals) {
          const current = yield* readNote(proposal.noteId).pipe(
            // A single unreadable note must not hide the rest of the review
            // queue. It is reported as stale; apply still fails closed.
            Effect.match({
              onFailure: () => null,
              onSuccess: (note) => note,
            }),
          )
          const currentHash = current?.contentHash ?? null
          const stale =
            proposal.operation === "create"
              ? current !== null
              : current === null || currentHash !== proposal.baseHash
          proposals.push({
            proposal,
            summary: proposal.summary,
            diff: proposalDiff({
              proposal,
              currentContent: current === null ? null : renderCurrent(current),
            }),
            stale,
            expired: proposal.expiresAt < edge,
            currentHash,
          })
        }

        return { proposals, invalid: scan.invalid, removed, quarantined }
      })

    const parseProposalNote = (
      proposal: ApprovalProposal,
    ): Effect.Effect<ParsedMarkdownNote, ApprovalError> =>
      Effect.gen(function* () {
        if (!("content" in proposal)) {
          return yield* Effect.fail(
            approvalError({
              code: "invalid-proposal",
              proposalId: proposal.id,
              noteId: proposal.noteId,
              path: proposal.path,
              message: "This proposal has no note content to apply.",
            }),
          )
        }
        const proposed = yield* parseMarkdownNote({
          path: proposal.path,
          content: proposal.content,
        }).pipe(
          Effect.mapError((error) =>
            approvalError({
              code: "invalid-proposal",
              proposalId: proposal.id,
              noteId: proposal.noteId,
              path: proposal.path,
              field: error.field,
              message: `The proposed note is invalid: ${error.message}`,
            }),
          ),
        )
        if (proposed.id !== proposal.noteId) {
          return yield* Effect.fail(
            approvalError({
              code: "invalid-proposal",
              proposalId: proposal.id,
              noteId: proposal.noteId,
              path: proposal.path,
              field: "id",
              message: "The proposed content does not carry the proposal's note ID.",
            }),
          )
        }
        return proposed
      })

    /**
     * A failed read after a mutation cannot prove the write did not happen.
     * Report that as `apply-unknown` rather than an ordinary repository
     * failure, so the caller knows to inspect before retrying.
     */
    const readForVerification = (
      proposal: { readonly id: string; readonly noteId: string; readonly path: string },
      noteId: string,
    ): Effect.Effect<ParsedMarkdownNote | null, ApprovalError> =>
      readNote(noteId).pipe(
        Effect.catch((error) =>
          Effect.fail(
            applyUnknown(
              proposal,
              `The note write may be durable, but it could not be read back for verification: ${error.message} Nothing further was written; inspect the note before retrying.`,
            ),
          ),
        ),
      )

    /**
     * Decides whether a durable intent's note mutation is already visible.
     * `prepared` is ambiguous after a crash, so it compares the note with the
     * proposal content or the recorded base hash. `applied` uses the recorded
     * result hash/backup path and never writes.
     */
    const verifyIntent = (
      intent: ApplyIntent,
      proposed: ParsedMarkdownNote | null,
      current: ParsedMarkdownNote | null,
    ): IntentVerification => {
      if (intent.phase === "applied") {
        if (intent.operation === "delete") {
          return current === null
            ? {
                status: "applied",
                note: null,
                ...(intent.backupPath === undefined
                  ? {}
                  : { backupPath: intent.backupPath }),
              }
            : {
                status: "conflict",
                message: `The apply intent recorded a verified delete of '${intent.noteId}', but the note exists again. Nothing was written by this retry.`,
              }
        }
        if (current === null) {
          return {
            status: "unknown",
            message: `The apply intent recorded a verified ${intent.operation} of '${intent.noteId}', but the note is now missing. Nothing was written by this retry; inspect the note root and reject the leftover proposal.`,
          }
        }
        if (
          intent.resultHash !== undefined &&
          current.contentHash === intent.resultHash
        ) {
          return { status: "applied", note: current }
        }
        if (
          proposed !== null &&
          noteMatchesProposal(current, proposed, intent.operation === "create")
        ) {
          return { status: "applied", note: current }
        }
        return {
          status: "unknown",
          message: `The apply intent recorded a verified ${intent.operation} of '${intent.noteId}', but the note has changed since. Nothing was written by this retry; inspect the note before rejecting the leftover proposal.`,
        }
      }

      // The mutation may or may not have reached the filesystem.
      if (intent.operation === "create") {
        if (current === null) {
          return { status: "not-applied" }
        }
        if (proposed !== null && noteMatchesProposal(current, proposed, true)) {
          return { status: "applied", note: current }
        }
        return {
          status: "conflict",
          message: `An apply intent for creating '${intent.noteId}' exists, but a different note already occupies that ID. Nothing was written by this retry; reject the proposal and propose again.`,
        }
      }

      if (intent.operation === "delete") {
        if (current === null) {
          return {
            status: "unknown",
            message: `An apply intent for deleting '${intent.noteId}' exists and the note is gone, but its backup path was not durably recorded before the process stopped. Nothing was written by this retry; inspect the backup directory before rejecting the proposal.`,
          }
        }
        if (current.contentHash === intent.baseHash) {
          return { status: "not-applied" }
        }
        return {
          status: "conflict",
          message: `An apply intent for deleting '${intent.noteId}' exists, but the note changed before the delete. Nothing was written by this retry; reject the proposal and propose again from the current note.`,
        }
      }

      if (current === null) {
        return {
          status: "conflict",
          message: `An apply intent for updating '${intent.noteId}' exists, but the note is missing. Nothing was written by this retry; reject the proposal.`,
        }
      }
      if (current.contentHash === intent.baseHash) {
        return { status: "not-applied" }
      }
      if (proposed !== null && noteMatchesProposal(current, proposed, false)) {
        return { status: "applied", note: current }
      }
      return {
        status: "conflict",
        message: `An apply intent for updating '${intent.noteId}' exists, but the note now differs from both its base and the proposed content. Nothing was written by this retry; reject the proposal and propose again from the current note.`,
      }
    }

    const markIntentApplied = (
      intent: ApplyIntent,
      result: { readonly resultHash?: string; readonly backupPath?: string },
    ): Effect.Effect<ApprovalError | null> =>
      intentStore
        .put({
          ...intent,
          phase: "applied",
          appliedAt: Markdown.toUtcTimestamp(now()).isoTimestamp,
          ...(result.resultHash === undefined
            ? {}
            : { resultHash: result.resultHash }),
          ...(result.backupPath === undefined
            ? {}
            : { backupPath: result.backupPath }),
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error)),
        )

    /**
     * Cleanup never turns a verified note change into a failed apply. The
     * proposal is removed first, then the intent, then the decision claim, so
     * a leftover intent can always be reconciled on retry and the claim keeps
     * reject blocked until the terminal apply cleanup is complete.
     */
    const cleanupApplied = (
      proposalId: string,
    ): Effect.Effect<ApprovalCleanup | undefined> =>
      Effect.gen(function* () {
        const warnings: string[] = []
        const proposalRemoved = yield* store.remove(proposalId).pipe(
          Effect.match({
            onFailure: (error) => ({ error, removed: false }),
            onSuccess: (removed) => ({ error: null, removed }),
          }),
        )
        if (proposalRemoved.error !== null) {
          warnings.push(
            `The note change is durable, but the proposal file could not be removed: ${proposalRemoved.error.message} Retry 'slipmem approve ${proposalId}' to finish cleanup.`,
          )
        } else {
          const intentRemoved = yield* intentStore.remove(proposalId).pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: () => ({ error: null }),
            }),
          )
          if (intentRemoved.error !== null) {
            warnings.push(
              `The note change is durable, but the apply intent could not be removed: ${intentRemoved.error.message} Retry 'slipmem approve ${proposalId}' to finish cleanup.`,
            )
          } else {
            const claimRemoved = yield* claimStore.remove(proposalId).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: () => ({ error: null }),
              }),
            )
            if (claimRemoved.error !== null) {
              warnings.push(
                `The note change is durable, but the approval decision claim could not be removed: ${claimRemoved.error.message} Retry 'slipmem approve ${proposalId}' to finish cleanup.`,
              )
            }
          }
        }
        return warnings.length === 0
          ? undefined
          : { status: "pending" as const, warning: warnings.join(" ") }
      })

    const finishApplied = (
      proposalId: string,
      intent: ApplyIntent,
      result: { readonly resultHash?: string; readonly backupPath?: string },
      payload: AppliedPayload,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      Effect.gen(function* () {
        const intentError = yield* markIntentApplied(intent, result)
        const index = yield* refreshDerivedIndex()
        if (intentError !== null) {
          // Keep the proposal and intent together so a retry still has the
          // proposal content to compare against the note.
          return {
            ...payload,
            index,
            cleanup: {
              status: "pending",
              warning: `The note change is durable, but the apply intent could not be marked applied: ${intentError.message} The proposal and intent were left in place; retry 'slipmem approve ${proposalId}' to finish cleanup.`,
            },
          }
        }
        const cleanup = yield* cleanupApplied(proposalId)
        return {
          ...payload,
          index,
          ...(cleanup === undefined ? {} : { cleanup }),
        }
      })

    const finishReconciled = (
      proposalId: string,
      intent: ApplyIntent,
      verification: Extract<IntentVerification, { readonly status: "applied" }>,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      Effect.gen(function* () {
        if (intent.operation === "delete") {
          if (verification.backupPath === undefined) {
            return yield* Effect.fail(
              approvalError({
                code: "apply-unknown",
                proposalId,
                noteId: intent.noteId,
                path: intent.path,
                message:
                  "The delete was verified, but its backup path was not durably recorded. Nothing was written by this retry; inspect the backup directory before rejecting the leftover proposal.",
              }),
            )
          }
          return yield* finishApplied(
            proposalId,
            intent,
            { backupPath: verification.backupPath },
            {
              status: "applied",
              proposalId,
              operation: "delete",
              noteId: intent.noteId,
              backupPath: verification.backupPath,
            },
          )
        }

        if (verification.note === null) {
          return yield* Effect.fail(
            approvalError({
              code: "apply-unknown",
              proposalId,
              noteId: intent.noteId,
              path: intent.path,
              message:
                "The apply intent is marked applied, but its note could not be read for verification. Nothing was written by this retry; inspect the note root before rejecting the leftover proposal.",
            }),
          )
        }
        return yield* finishApplied(
          proposalId,
          intent,
          { resultHash: verification.note.contentHash },
          {
            status: "applied",
            proposalId,
            operation: intent.operation,
            noteId: intent.noteId,
            note: verification.note,
          },
        )
      })

    const decisionAlreadyRejected = (proposalId: string): ApprovalError =>
      approvalError({
        code: "proposal-not-found",
        proposalId,
        message: `Proposal '${proposalId}' was already rejected. No apply was attempted.`,
      })

    const decisionApplyPending = (proposalId: string): ApprovalError =>
      approvalError({
        code: "proposal-not-found",
        proposalId,
        message: `Proposal '${proposalId}' has an apply decision in progress or awaiting reconciliation. Retry 'slipmem approve ${proposalId}' before rejecting it.`,
      })

    const ensureApplyClaim = (
      proposalId: string,
    ): Effect.Effect<{ readonly claimCreated: boolean }, ApprovalError> =>
      Effect.gen(function* () {
        const existing = yield* claimStore.get(proposalId)
        if (Option.isSome(existing)) {
          return existing.value.decision === "reject"
            ? yield* Effect.fail(decisionAlreadyRejected(proposalId))
            : { claimCreated: false }
        }
        const result = yield* claimStore.claim(proposalId, "apply")
        return result.claim.decision === "reject"
          ? yield* Effect.fail(decisionAlreadyRejected(proposalId))
          : { claimCreated: result.status === "claimed" }
      })

    const ensureRejectClaim = (
      proposalId: string,
    ): Effect.Effect<{ readonly claimCreated: boolean }, ApprovalError> =>
      Effect.gen(function* () {
        const existing = yield* claimStore.get(proposalId)
        if (Option.isSome(existing)) {
          return existing.value.decision === "apply"
            ? yield* Effect.fail(decisionApplyPending(proposalId))
            : { claimCreated: false }
        }
        const result = yield* claimStore.claim(proposalId, "reject")
        return result.claim.decision === "apply"
          ? yield* Effect.fail(decisionApplyPending(proposalId))
          : { claimCreated: result.status === "claimed" }
      })

    const reconcileWithoutProposal = (
      proposalId: string,
      intent: ApplyIntent,
      progress: ApplyProgress,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      Effect.gen(function* () {
        // An intent means an earlier attempt may have changed the note.
        progress.mayHaveWritten = true
        const current = yield* readNote(intent.noteId).pipe(
          Effect.catch((error) =>
            Effect.fail(
              approvalError({
                code: "apply-unknown",
                proposalId,
                noteId: intent.noteId,
                path: intent.path,
                message: `Could not read the note to reconcile the durable apply intent: ${error.message} Nothing was written by this retry; inspect the note before rejecting the leftover proposal.`,
              }),
            ),
          ),
        )
        const verification = verifyIntent(intent, null, current)
        switch (verification.status) {
          case "applied":
            return yield* finishReconciled(proposalId, intent, verification)
          case "conflict":
            progress.mayHaveWritten = true
            return yield* Effect.fail(
              approvalError({
                code: "apply-conflict",
                proposalId,
                noteId: intent.noteId,
                path: intent.path,
                message: verification.message,
              }),
            )
          case "unknown":
            progress.mayHaveWritten = true
            return yield* Effect.fail(
              approvalError({
                code: "apply-unknown",
                proposalId,
                noteId: intent.noteId,
                path: intent.path,
                message: verification.message,
              }),
            )
          case "not-applied":
            // The proposal is gone and the note is still at its base (or
            // absent for a create), so this intent never produced a change.
            // Preserve a foreign live claim/intent for the owner to reconcile.
            progress.mayHaveWritten = false
            if (progress.claimCreated) {
              yield* intentStore.remove(proposalId).pipe(Effect.ignore)
              yield* claimStore.remove(proposalId).pipe(Effect.ignore)
            }
            return yield* Effect.fail(
              approvalError({
                code: "proposal-not-found",
                proposalId,
                message: `Proposal '${proposalId}' was not found. It may already be applied, rejected, or expired.`,
              }),
            )
        }
      })

    const applyUnlocked = (
      proposalId: string,
      progress: ApplyProgress,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      Effect.gen(function* () {
        const found = yield* store.get(proposalId)
        const foundIntent = yield* intentStore.get(proposalId).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // An unreadable intent may describe an earlier durable write.
              progress.mayHaveWritten = true
            }),
          ),
        )

        if (Option.isNone(found)) {
          if (Option.isNone(foundIntent)) {
            // The proposal and intent are both gone, so this claim cannot
            // fence a live apply. Remove a leftover cleanup claim so it does
            // not block reject forever.
            yield* claimStore.remove(proposalId).pipe(Effect.ignore)
            return yield* Effect.fail(
              approvalError({
                code: "proposal-not-found",
                proposalId,
                message: `Proposal '${proposalId}' was not found. It may already be applied, rejected, or expired.`,
              }),
            )
          }
          return yield* reconcileWithoutProposal(
            proposalId,
            foundIntent.value,
            progress,
          )
        }

        const proposal = found.value
        const path = yield* notePath(repository.root, proposal.noteId).pipe(
          Effect.mapError((error) =>
            repositoryFailure("resolve the proposal note path", error),
          ),
        )
        if (path !== proposal.path) {
          return yield* Effect.fail(
            approvalError({
              code: "invalid-proposal",
              proposalId,
              noteId: proposal.noteId,
              path: proposal.path,
              message:
                "The proposal path is not the canonical note path. No note was written.",
            }),
          )
        }

        const proposed =
          proposal.operation === "delete"
            ? null
            : yield* parseProposalNote(proposal)
        const intent = Option.getOrNull(foundIntent)
        if (intent !== null) {
          // A durable intent means a previous attempt may have reached the
          // note even if this retry has not.
          progress.mayHaveWritten = true
        }

        if (intent !== null) {
          if (intent.proposalHash !== proposalFingerprint(proposal)) {
            return yield* Effect.fail(
              applyUnknown(
                proposal,
                "The durable apply intent does not match the current proposal file. Nothing was written by this retry; inspect .state/apply-intent and the proposal before retrying.",
              ),
            )
          }
          const current = yield* readNote(proposal.noteId)
          const verification = verifyIntent(intent, proposed, current)
          switch (verification.status) {
            case "applied":
              progress.mayHaveWritten = true
              return yield* finishReconciled(proposalId, intent, verification)
            case "conflict":
              progress.mayHaveWritten = true
              return yield* Effect.fail(
                applyConflict(proposal, verification.message),
              )
            case "unknown":
              progress.mayHaveWritten = true
              return yield* Effect.fail(
                applyUnknown(proposal, verification.message),
              )
            case "not-applied":
              progress.mayHaveWritten = false
              break
          }
        }

        const edge = Markdown.toUtcTimestamp(now()).isoTimestamp
        if (proposal.expiresAt < edge) {
          // A duplicate approve may observe a claim/intent owned by an apply
          // that is still in flight. Only the process that created the claim
          // may clean it up here; otherwise reject could race the live write.
          if (progress.claimCreated) {
            if (intent !== null) {
              yield* intentStore.remove(proposalId).pipe(Effect.ignore)
            }
            yield* claimStore.remove(proposalId).pipe(Effect.ignore)
          }
          return yield* Effect.fail(
            approvalError({
              code: "proposal-expired",
              proposalId,
              noteId: proposal.noteId,
              path: proposal.path,
              message: `Proposal '${proposalId}' expired at ${proposal.expiresAt}. Ask the agent to propose again.`,
            }),
          )
        }

        const current = yield* readNote(proposal.noteId)
        if (proposal.operation === "create") {
          if (current !== null) {
            return yield* Effect.fail(
              approvalError({
                code: "target-exists",
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                message: `Note '${proposal.noteId}' already exists. The proposal is stale; reject it and ask the agent to propose again.`,
              }),
            )
          }
        } else {
          if (current === null) {
            return yield* Effect.fail(
              approvalError({
                code: "target-missing",
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                message: `Note '${proposal.noteId}' no longer exists. The proposal is stale; reject it.`,
              }),
            )
          }
          if (current.contentHash !== proposal.baseHash) {
            return yield* Effect.fail(
              approvalError({
                code: "stale-base",
                proposalId,
                noteId: proposal.noteId,
                path: current.path,
                message:
                  "The note changed after this proposal was created, so the base hash no longer matches. Nothing was written; ask the agent to propose again from the current note.",
              }),
            )
          }
        }

        if (proposed !== null && proposal.operation !== "create") {
          if (proposed.metadata.createdAt !== current!.metadata.createdAt) {
            return yield* Effect.fail(
              approvalError({
                code: "invalid-proposal",
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                field: "createdAt",
                message:
                  "The proposed content changed the note creation timestamp. No note was written.",
              }),
            )
          }
          if (
            !sameValue(proposed.unknown, current!.unknown) ||
            proposed.metadata.legacyId !== current!.metadata.legacyId ||
            !sameStringList(
              proposed.metadata.aliases,
              current!.metadata.aliases,
            )
          ) {
            return yield* Effect.fail(
              approvalError({
                code: "invalid-proposal",
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                field: "frontmatter",
                message:
                  "The proposed content changed frontmatter outside the note contract. No note was written; ask the agent to propose again from the current note.",
              }),
            )
          }
        }

        const preparedIntent =
          intent ??
          (yield* intentStore.put({
            proposalId,
            operation: proposal.operation,
            noteId: proposal.noteId,
            path: proposal.path,
            phase: "prepared",
            ...(proposal.baseHash === undefined
              ? {}
              : { baseHash: proposal.baseHash }),
            proposalHash: proposalFingerprint(proposal),
            preparedAt: Markdown.toUtcTimestamp(now()).isoTimestamp,
          }))

        if (proposal.operation === "create") {
          progress.mayHaveWritten = true
          const created = yield* repository
            .create({
              id: proposal.noteId,
              type: proposed!.metadata.type,
              title: proposed!.metadata.title,
              content: proposed!.body,
              createdAt: Date.parse(proposed!.metadata.createdAt),
              updatedAt: Date.parse(proposed!.metadata.updatedAt),
              ...(proposed!.metadata.reference === undefined
                ? {}
                : { reference: proposed!.metadata.reference }),
              ...(proposed!.metadata.tags === undefined
                ? {}
                : { tags: proposed!.metadata.tags }),
              ...(proposed!.metadata.provenance === undefined
                ? {}
                : { provenance: proposed!.metadata.provenance }),
              ...(proposed!.metadata.legacyId === undefined
                ? {}
                : { legacyId: proposed!.metadata.legacyId }),
              ...(proposed!.metadata.aliases === undefined
                ? {}
                : { aliases: proposed!.metadata.aliases }),
              unknown: proposed!.unknown,
            })
            .pipe(
              Effect.mapError((error) => {
                progress.mayHaveWritten = repositoryErrorMayHaveWritten(error.code)
                return applyCreateRepositoryFailure(proposal, error)
              }),
            )

          if (created.id !== proposal.noteId) {
            // The repository's exact-ID primitive must never land under a
            // different ID. Fail closed without a compensating delete: a
            // delete here could remove an unrelated note if the invariant is
            // ever broken.
            return yield* Effect.fail(
              applyUnknown(
                proposal,
                `The repository created note '${created.id}' instead of the proposal's '${proposal.noteId}'. No compensating delete was attempted; inspect the note root before retrying.`,
              ),
            )
          }

          const verified = yield* readForVerification(proposal, proposal.noteId)
          if (
            verified === null ||
            verified.contentHash !== created.contentHash
          ) {
            return yield* Effect.fail(
              applyConflict(
                proposal,
                "The note changed between the approved write and its verification. The approved write may be durable, but it could not be verified; inspect the note before retrying.",
              ),
            )
          }

          return yield* finishApplied(
            proposalId,
            preparedIntent,
            { resultHash: verified.contentHash },
            {
              status: "applied",
              proposalId,
              operation: "create",
              noteId: verified.id,
              note: verified,
            },
          )
        }

        if (proposal.operation === "delete") {
          progress.mayHaveWritten = true
          const deleted = yield* repository
            .delete(proposal.noteId, {
              expectedContentHash: proposal.baseHash,
            })
            .pipe(
              Effect.mapError((error) => {
                progress.mayHaveWritten = repositoryErrorMayHaveWritten(error.code)
                return applyRepositoryFailure(
                  "apply the delete proposal",
                  proposal,
                  error,
                )
              }),
            )

          const remaining = yield* readForVerification(proposal, proposal.noteId)
          if (remaining !== null) {
            return yield* Effect.fail(
              applyConflict(
                proposal,
                "The delete returned successfully, but the note is still present. Nothing was deleted by this retry; inspect the note root before retrying.",
              ),
            )
          }

          return yield* finishApplied(
            proposalId,
            preparedIntent,
            { backupPath: deleted.backupPath },
            {
              status: "applied",
              proposalId,
              operation: "delete",
              noteId: deleted.id,
              backupPath: deleted.backupPath,
            },
          )
        }

        progress.mayHaveWritten = true
        const updated = yield* repository
          .update({
            id: proposal.noteId,
            type: proposed!.metadata.type,
            title: proposed!.metadata.title,
            content: proposed!.body,
            reference: proposed!.metadata.reference ?? null,
            tags: proposed!.metadata.tags ?? [],
            ...(proposed!.metadata.provenance === undefined
              ? {}
              : { provenance: proposed!.metadata.provenance }),
            ...(proposed!.metadata.legacyId === undefined
              ? {}
              : { legacyId: proposed!.metadata.legacyId }),
            ...(proposed!.metadata.aliases === undefined
              ? {}
              : { aliases: proposed!.metadata.aliases }),
            // Keep unknown frontmatter exactly as the human reviewed it. The
            // repository merges this over the current record, so no source is
            // dropped.
            unknown: proposed!.unknown,
            expectedContentHash: proposal.baseHash,
          })
          .pipe(
            Effect.mapError((error) => {
              progress.mayHaveWritten = repositoryErrorMayHaveWritten(error.code)
              return applyRepositoryFailure(
                "apply the update proposal",
                proposal,
                error,
              )
            }),
          )

        const verified = yield* readForVerification(proposal, proposal.noteId)
        if (verified === null || verified.contentHash !== updated.contentHash) {
          return yield* Effect.fail(
            applyConflict(
              proposal,
              "The note changed between the approved write and its verification. The approved write may be durable, but it could not be verified; inspect the note before retrying.",
            ),
          )
        }

        return yield* finishApplied(
          proposalId,
          preparedIntent,
          { resultHash: verified.contentHash },
          {
            status: "applied",
            proposalId,
            operation: proposal.operation,
            noteId: verified.id,
            note: verified,
          },
        )
      })

    const apply = (
      proposalId: string,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      withApprovalDecisionLock(
        repository.root,
        proposalId,
        Effect.gen(function* () {
          const claim = yield* ensureApplyClaim(proposalId)
          const progress: ApplyProgress = {
            mayHaveWritten: false,
            claimCreated: claim.claimCreated,
          }
          return yield* applyUnlocked(proposalId, progress).pipe(
            Effect.onError(() =>
              progress.mayHaveWritten || !progress.claimCreated
                ? Effect.void
                : claimStore.remove(proposalId).pipe(Effect.ignore),
            ),
          )
        }),
      )

    const reject = (
      proposalId: string,
    ): Effect.Effect<ApprovalRejection, ApprovalError> =>
      withApprovalDecisionLock(
        repository.root,
        proposalId,
        Effect.gen(function* () {
          const claim = yield* ensureRejectClaim(proposalId)
          const removed = yield* store.remove(proposalId).pipe(
            Effect.match({
              onFailure: (error) => ({ error, removed: false }),
              onSuccess: (removed) => ({ error: null, removed }),
            }),
          )
          if (removed.error !== null) {
            if (claim.claimCreated) {
              yield* claimStore.remove(proposalId).pipe(Effect.ignore)
            }
            return yield* Effect.fail(removed.error)
          }
          if (!removed.removed) {
            // The proposal is gone, so no reject can still be in flight under
            // this claim. Remove it even if another process created it.
            yield* claimStore.remove(proposalId).pipe(Effect.ignore)
            return yield* Effect.fail(
              approvalError({
                code: "proposal-not-found",
                proposalId,
                message: `Proposal '${proposalId}' was not found, so there was nothing to reject.`,
              }),
            )
          }
          // A rejected proposal cannot be applied later, so its intent is dead
          // state. Cleanup failure here does not undo the rejection.
          yield* intentStore.remove(proposalId).pipe(Effect.ignore)
          yield* claimStore.remove(proposalId).pipe(Effect.ignore)
          return { status: "rejected", proposalId }
        }),
      )

    const cleanupExpired = (
      nowMs?: number,
    ): Effect.Effect<ReadonlyArray<string>, ApprovalError> =>
      Effect.gen(function* () {
        const result = yield* store.cleanupExpired(nowMs)
        for (const proposalId of result.removed) {
          const claim = yield* claimStore.get(proposalId).pipe(
            Effect.match({
              onFailure: () => ({ known: false as const }),
              onSuccess: (value) => ({ known: true as const, value }),
            }),
          )
          // An unreadable claim is left for manual review. A live claim means
          // an apply is still in flight; deleting its intent would break
          // reconciliation and let a concurrent reject win.
          if (!claim.known) {
            continue
          }
          if (
            Option.isSome(claim.value) &&
            approvalClaimOwnerIsAlive(claim.value.value)
          ) {
            continue
          }
          yield* intentStore.remove(proposalId).pipe(Effect.ignore)
          yield* claimStore.remove(proposalId).pipe(Effect.ignore)
        }
        return result.removed
      })

    return {
      root: repository.root,
      policy,
      submitMcp,
      review,
      apply,
      reject,
      cleanupExpired,
    }
  })

const renderCurrent = (note: ParsedMarkdownNote): string =>
  renderNoteDocument({
    metadata: note.metadata,
    body: note.body,
    unknown: note.unknown,
  })

/**
 * Convenience predicate for surfaces that must keep review/apply/reject out of
 * the MCP tool table. Proposal IDs are accepted by the human service only.
 */
export const isApprovalProposalId = (value: string): boolean =>
  PROPOSAL_ID_PATTERN.test(value)

/** Builds the approval service from the ambient Markdown repository. */
export const ApprovalServiceLive = (
  config: ApprovalServiceConfig = {},
): Layer.Layer<ApprovalService, ApprovalError, MarkdownNoteRepository> =>
  Layer.effect(
    ApprovalService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      return yield* makeApprovalService(repository, config)
    }),
  )
