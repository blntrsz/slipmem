import { Markdown } from "@slipmem/schemas/markdown"
import { Context, Effect, Layer, Option } from "effect"
import { randomBytes } from "node:crypto"
import { parseMarkdownNote, type ParsedMarkdownNote } from "../markdown/note-document.js"
import { renderNoteDocument } from "../markdown/frontmatter.js"
import { notePath } from "../markdown/paths.js"
import {
  MarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
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
}

export interface McpCreateInput {
  readonly operation: "create"
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly topics?: ReadonlyArray<string>
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
  readonly topics?: ReadonlyArray<string>
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
}

export type ApprovalApplication =
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

const normalizeTopics = (
  topics: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, ApprovalError> =>
  Effect.gen(function* () {
    if (topics === undefined) {
      return undefined
    }
    const normalized: string[] = []
    for (const topic of topics) {
      const slug = Markdown.slugifyTopic(topic)
      if (slug === "") {
        return yield* Effect.fail(
          invalidRequest(
            `Topic '${topic}' does not normalize to a usable slug.`,
            "topics",
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

/**
 * Builds the approval service for one repository.
 *
 * The service owns proposal creation, human review/apply/reject, TTL cleanup,
 * and the MCP write policy. It only uses the repository's scan/get/create/
 * update/delete methods; all note writes keep the repository's atomic write and
 * lock behavior. Applying a proposal stamps a fresh `updatedAt` through the
 * repository, so the applied file is not byte-identical to the proposed preview,
 * but every proposed field is revalidated first.
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

    const readNote = (
      id: string,
    ): Effect.Effect<ParsedMarkdownNote | null, ApprovalError> =>
      repository.get(id).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError((error) => repositoryFailure(`read note '${id}'`, error)),
      )

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
        const topics = yield* normalizeTopics(input.topics)
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
              ...(topics === undefined ? {} : { topics }),
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
          createdAt: nowMs,
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
          ...(topics === undefined || topics.length === 0 ? {} : { topics }),
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
        const topics = yield* normalizeTopics(input.topics)
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
              ...(topics === undefined ? {} : { topics }),
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
          ...(topics === undefined
            ? {}
            : topics.length === 0
              ? { topics: undefined }
              : { topics }),
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
        const removed =
          options.cleanupExpired === false ? [] : yield* store.cleanupExpired(now())
        const edge = Markdown.toUtcTimestamp(now()).isoTimestamp
        const scan = yield* store.scan()
        const proposals: ApprovalReviewItem[] = []

        for (const proposal of scan.proposals) {
          const current = yield* readNote(proposal.noteId)
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

        return { proposals, invalid: scan.invalid, removed }
      })

    const apply = (
      proposalId: string,
    ): Effect.Effect<ApprovalApplication, ApprovalError> =>
      Effect.gen(function* () {
        const found = yield* store.get(proposalId)
        if (Option.isNone(found)) {
          return yield* Effect.fail(
            approvalError({
              code: "proposal-not-found",
              proposalId,
              message: `Proposal '${proposalId}' was not found. It may already be applied, rejected, or expired.`,
            }),
          )
        }
        const proposal = found.value
        const edge = Markdown.toUtcTimestamp(now()).isoTimestamp
        if (proposal.expiresAt < edge) {
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

        const path = yield* notePath(repository.root, proposal.noteId).pipe(
          Effect.mapError((error) => repositoryFailure("resolve the proposal note path", error)),
        )
        if (path !== proposal.path) {
          return yield* Effect.fail(
            approvalError({
              code: "invalid-proposal",
              proposalId,
              noteId: proposal.noteId,
              path: proposal.path,
              message: "The proposal path is not the canonical note path. No note was written.",
            }),
          )
        }

        if (proposal.operation === "create") {
          const existing = yield* readNote(proposal.noteId)
          if (existing !== null) {
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

          const proposed = yield* parseMarkdownNote({
            path: proposal.path,
            content: proposal.content,
          }).pipe(
            Effect.mapError((error) =>
              approvalError({
                code: "invalid-proposal",
                proposalId,
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
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                field: "id",
                message: "The proposed content does not carry the proposal's note ID.",
              }),
            )
          }

          const created = yield* repository
            .create({
              type: proposed.metadata.type,
              title: proposed.metadata.title,
              content: proposed.body,
              createdAt: Date.parse(proposed.metadata.createdAt),
              updatedAt: Date.parse(proposed.metadata.updatedAt),
              ...(proposed.metadata.reference === undefined
                ? {}
                : { reference: proposed.metadata.reference }),
              ...(proposed.metadata.topics === undefined
                ? {}
                : { topics: proposed.metadata.topics }),
              ...(proposed.metadata.provenance === undefined
                ? {}
                : { provenance: proposed.metadata.provenance }),
              ...(proposed.metadata.legacyId === undefined
                ? {}
                : { legacyId: proposed.metadata.legacyId }),
              ...(proposed.metadata.aliases === undefined
                ? {}
                : { aliases: proposed.metadata.aliases }),
            })
            .pipe(
              Effect.mapError((error) => repositoryFailure("apply the create proposal", error)),
            )

          if (created.id !== proposal.noteId) {
            // The reserved filename was taken between proposal and approval.
            // Remove the newly created suffixed note through the repository's
            // backup path, then fail without touching the original target.
            yield* repository.delete(created.id).pipe(Effect.ignore)
            return yield* Effect.fail(
              approvalError({
                code: "stale-base",
                proposalId,
                noteId: proposal.noteId,
                path: proposal.path,
                message: `The proposal's filename '${proposal.noteId}' is no longer available. No note was written under that ID; ask the agent to propose again.`,
              }),
            )
          }

          yield* store.remove(proposalId)
          return {
            status: "applied",
            proposalId,
            operation: "create",
            noteId: created.id,
            note: created,
          }
        }

        const current = yield* readNote(proposal.noteId)
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

        if (proposal.operation === "delete") {
          const deleted = yield* repository.delete(proposal.noteId).pipe(
            Effect.mapError((error) => repositoryFailure("apply the delete proposal", error)),
          )
          yield* store.remove(proposalId)
          return {
            status: "applied",
            proposalId,
            operation: "delete",
            noteId: deleted.id,
            backupPath: deleted.backupPath,
          }
        }

        const proposed = yield* parseMarkdownNote({
          path: proposal.path,
          content: proposal.content,
        }).pipe(
          Effect.mapError((error) =>
            approvalError({
              code: "invalid-proposal",
              proposalId,
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
              proposalId,
              noteId: proposal.noteId,
              path: proposal.path,
              field: "id",
              message: "The proposed content does not carry the proposal's note ID.",
            }),
          )
        }
        if (proposed.metadata.createdAt !== current.metadata.createdAt) {
          return yield* Effect.fail(
            approvalError({
              code: "invalid-proposal",
              proposalId,
              noteId: proposal.noteId,
              path: proposal.path,
              field: "createdAt",
              message: "The proposed content changed the note creation timestamp. No note was written.",
            }),
          )
        }

        const updated = yield* repository
          .update({
            id: proposal.noteId,
            type: proposed.metadata.type,
            title: proposed.metadata.title,
            content: proposed.body,
            reference: proposed.metadata.reference ?? null,
            topics: proposed.metadata.topics ?? [],
            ...(proposed.metadata.provenance === undefined
              ? {}
              : { provenance: proposed.metadata.provenance }),
            ...(proposed.metadata.legacyId === undefined
              ? {}
              : { legacyId: proposed.metadata.legacyId }),
            ...(proposed.metadata.aliases === undefined
              ? {}
              : { aliases: proposed.metadata.aliases }),
          })
          .pipe(
            Effect.mapError((error) => repositoryFailure("apply the update proposal", error)),
          )

        yield* store.remove(proposalId)
        return {
          status: "applied",
          proposalId,
          operation: proposal.operation,
          noteId: updated.id,
          note: updated,
        }
      })

    const reject = (
      proposalId: string,
    ): Effect.Effect<ApprovalRejection, ApprovalError> =>
      Effect.gen(function* () {
        const removed = yield* store.remove(proposalId)
        if (!removed) {
          return yield* Effect.fail(
            approvalError({
              code: "proposal-not-found",
              proposalId,
              message: `Proposal '${proposalId}' was not found, so there was nothing to reject.`,
            }),
          )
        }
        return { status: "rejected", proposalId }
      })

    const cleanupExpired = (
      nowMs?: number,
    ): Effect.Effect<ReadonlyArray<string>, ApprovalError> =>
      store.cleanupExpired(nowMs)

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
