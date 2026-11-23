import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { markdownError } from "../markdown/errors.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  approvalError,
  makeApplyIntentStore,
  makeApprovalClaimStore,
  makeApprovalService,
  makeProposalStore,
  type ApprovalClaimStoreShape,
  type ApprovalError,
  type ApprovalServiceShape,
  type ApplyIntentStoreShape,
  type McpWriteInput,
  type McpWriteResult,
  type ProposalStoreShape,
} from "./index.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly pending: string
  readonly claims: string
  readonly intents: string
  readonly clock: { value: number }
  readonly repository: MarkdownNoteRepositoryShape
  readonly store: ProposalStoreShape
  readonly intentStore: ApplyIntentStoreShape
  readonly claimStore: ApprovalClaimStoreShape
  readonly service: ApprovalServiceShape
}

interface FixtureOptions {
  readonly ttlMs?: number
  readonly repository?: (
    repository: MarkdownNoteRepositoryShape,
  ) => MarkdownNoteRepositoryShape
  readonly store?: (store: ProposalStoreShape) => ProposalStoreShape
  readonly intentStore?: (
    store: ApplyIntentStoreShape,
  ) => ApplyIntentStoreShape
}

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-approval-concurrency-"))
  const root = join(base, ".slipmem")
  const backup = join(base, "backups")
  mkdirSync(root, { recursive: true })
  const clock = { value: FIXED_NOW }
  const baseRepository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir: backup,
      now: () => clock.value,
    }),
  )
  const baseStore = await Effect.runPromise(
    makeProposalStore({
      root,
      now: () => clock.value,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
  )
  const baseIntentStore = await Effect.runPromise(
    makeApplyIntentStore({ root }),
  )
  const claimStore = await Effect.runPromise(
    makeApprovalClaimStore({ root, now: () => clock.value }),
  )
  const repository = options.repository?.(baseRepository) ?? baseRepository
  const store = options.store?.(baseStore) ?? baseStore
  const intentStore = options.intentStore?.(baseIntentStore) ?? baseIntentStore
  const service = await Effect.runPromise(
    makeApprovalService(repository, {
      now: () => clock.value,
      actor: "test-agent",
      env: {},
      store,
      intentStore,
      claimStore,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
  )
  return {
    base,
    root,
    pending: join(root, ".state", "pending"),
    claims: join(root, ".state", "approval-claim"),
    intents: join(root, ".state", "apply-intent"),
    clock,
    repository: baseRepository,
    store,
    intentStore,
    claimStore,
    service,
  }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const jsonFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).filter((name) => name.endsWith(".json"))

const submit = (
  fixture: Fixture,
  input: McpWriteInput,
): Promise<McpWriteResult> =>
  Effect.runPromise(fixture.service.submitMcp(input))

const settle = <A>(
  promise: Promise<A>,
): Promise<
  { readonly ok: true; readonly value: A } |
  { readonly ok: false; readonly error: ApprovalError }
> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: ApprovalError) => ({ ok: false as const, error }),
  )

const proposalFingerprint = (proposal: {
  readonly operation: string
  readonly noteId: string
  readonly path: string
  readonly baseHash?: string
  readonly content?: string
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        operation: proposal.operation,
        noteId: proposal.noteId,
        path: proposal.path,
        baseHash: proposal.baseHash ?? null,
        content: proposal.content ?? null,
      }),
    )
    .digest("hex")

const barrier = () => {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let reach!: () => void
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  return { release, released, reach, reached }
}

const permanentCreate = (title: string): McpWriteInput => ({
  operation: "create",
  type: "permanent",
  title,
  content: `Body for ${title}.`,
})

describe("approval decision concurrency", () => {
  test("an in-progress apply blocks reject from reporting a rejection", async () => {
    const gate = barrier()
    const fixture = await createFixture({
      repository: (repository) => ({
        ...repository,
        create: (input) =>
          Effect.gen(function* () {
            gate.reach()
            yield* Effect.promise(() => gate.released)
            return yield* repository.create(input)
          }),
      }),
    })
    try {
      const pending = await submit(fixture, permanentCreate("Apply Wins"))
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const applying = settle(
        Effect.runPromise(fixture.service.apply(pending.proposalId)),
      )
      await gate.reached
      const rejecting = settle(
        Effect.runPromise(fixture.service.reject(pending.proposalId)),
      )
      gate.release()

      const applied = await applying
      expect(applied.ok).toBe(true)
      if (applied.ok) {
        expect(applied.value.status).toBe("applied")
      }

      const rejected = await rejecting
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("proposal-not-found")
      }

      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.claims)).toHaveLength(0)
      const stored = await Effect.runPromise(
        fixture.repository.get("apply-wins"),
      )
      expect(stored._tag).toBe("Some")
    } finally {
      cleanup(fixture)
    }
  })

  test("an in-progress reject blocks apply from reporting an application", async () => {
    const gate = barrier()
    const fixture = await createFixture({
      store: (store) => ({
        ...store,
        remove: (proposalId) =>
          Effect.gen(function* () {
            gate.reach()
            yield* Effect.promise(() => gate.released)
            return yield* store.remove(proposalId)
          }),
      }),
    })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Reject Wins",
          content: "Keep this body.",
        }),
      )
      const pending = await submit(fixture, {
        operation: "update",
        id: note.id,
        content: "Approved body.",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const rejecting = settle(
        Effect.runPromise(fixture.service.reject(pending.proposalId)),
      )
      await gate.reached
      const applying = settle(
        Effect.runPromise(fixture.service.apply(pending.proposalId)),
      )
      gate.release()

      const rejected = await rejecting
      expect(rejected.ok).toBe(true)
      if (rejected.ok) {
        expect(rejected.value.status).toBe("rejected")
      }

      const applied = await applying
      expect(applied.ok).toBe(false)
      if (!applied.ok) {
        expect(applied.error.code).toBe("proposal-not-found")
      }

      const stored = await Effect.runPromise(fixture.repository.get(note.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("Keep this body.")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.claims)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a cleanup-pending apply keeps the claim and blocks reject", async () => {
    const fixture = await createFixture({
      store: (store) => {
        let failures = 1
        return {
          ...store,
          remove: (proposalId) =>
            failures > 0
              ? Effect.sync(() => {
                  failures--
                }).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      approvalError({
                        code: "proposal-write-failed",
                        proposalId,
                        message: "simulated cleanup failure",
                      }),
                    ),
                  ),
                )
              : store.remove(proposalId),
        }
      },
    })
    try {
      const pending = await submit(fixture, permanentCreate("Claim Stays"))
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const applied = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(applied.status).toBe("applied")
      expect(applied.cleanup?.status).toBe("pending")
      expect(jsonFiles(fixture.claims)).toHaveLength(1)

      const rejected = await settle(
        Effect.runPromise(fixture.service.reject(pending.proposalId)),
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("proposal-not-found")
        expect(rejected.error.message).toContain("apply decision")
      }

      const retried = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(retried.status).toBe("applied")
      expect(retried.cleanup).toBeUndefined()
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.claims)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a pre-mutation apply failure releases the claim for reject", async () => {
    const fixture = await createFixture()
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Failed Apply",
          content: "Base body.",
        }),
      )
      const pending = await submit(fixture, {
        operation: "update",
        id: note.id,
        content: "Approved body.",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      await Effect.runPromise(
        fixture.repository.update({
          id: note.id,
          content: "External edit wins.",
        }),
      )

      const failed = await settle(
        Effect.runPromise(fixture.service.apply(pending.proposalId)),
      )
      expect(failed.ok).toBe(false)
      if (!failed.ok) {
        expect(failed.error.code).toBe("stale-base")
      }
      expect(jsonFiles(fixture.claims)).toHaveLength(0)

      const rejected = await Effect.runPromise(
        fixture.service.reject(pending.proposalId),
      )
      expect(rejected).toEqual({
        status: "rejected",
        proposalId: pending.proposalId,
      })
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.claims)).toHaveLength(0)

      const stored = await Effect.runPromise(fixture.repository.get(note.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("External edit wins.")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("a post-mutation apply failure keeps the claim and blocks reject", async () => {
    const fixture = await createFixture({
      repository: (repository) => ({
        ...repository,
        delete: (id, options) =>
          Effect.gen(function* () {
            yield* repository.delete(id, options)
            return yield* Effect.fail(
              markdownError({
                area: "repository",
                code: "write-failed",
                path: repository.root,
                message: "simulated crash after the backup move",
              }),
            )
          }),
      }),
    })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Uncertain Apply",
          content: "Deleted before the error was reported.",
        }),
      )
      const pending = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const failed = await settle(
        Effect.runPromise(fixture.service.apply(pending.proposalId)),
      )
      expect(failed.ok).toBe(false)
      if (!failed.ok) {
        expect(failed.error.code).toBe("repository-failure")
      }
      expect(existsSync(note.path)).toBe(false)
      expect(jsonFiles(fixture.claims)).toHaveLength(1)

      const rejected = await settle(
        Effect.runPromise(fixture.service.reject(pending.proposalId)),
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("proposal-not-found")
        expect(rejected.error.message).toContain("apply decision")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(1)
      expect(jsonFiles(fixture.claims)).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })

  test("a leftover apply claim without proposal or intent is cleaned up", async () => {
    const fixture = await createFixture()
    try {
      const proposalId = "proposal-20261117213000-deadbeef"
      await Effect.runPromise(fixture.claimStore.claim(proposalId, "apply"))
      expect(jsonFiles(fixture.claims)).toHaveLength(1)

      const result = await settle(
        Effect.runPromise(fixture.service.apply(proposalId)),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("proposal-not-found")
      }
      expect(jsonFiles(fixture.claims)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a claim written by another process fences both decisions", async () => {
    const fixture = await createFixture()
    try {
      const first = await submit(fixture, permanentCreate("Foreign Reject"))
      if (first.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const rejectClaim = await Effect.runPromise(
        fixture.claimStore.claim(first.proposalId, "reject"),
      )
      expect(rejectClaim.status).toBe("claimed")

      const blockedApply = await settle(
        Effect.runPromise(fixture.service.apply(first.proposalId)),
      )
      expect(blockedApply.ok).toBe(false)
      if (!blockedApply.ok) {
        expect(blockedApply.error.code).toBe("proposal-not-found")
        expect(blockedApply.error.message).toContain("already rejected")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(1)

      const second = await submit(fixture, permanentCreate("Foreign Apply"))
      if (second.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const applyClaim = await Effect.runPromise(
        fixture.claimStore.claim(second.proposalId, "apply"),
      )
      expect(applyClaim.status).toBe("claimed")

      const blockedReject = await settle(
        Effect.runPromise(fixture.service.reject(second.proposalId)),
      )
      expect(blockedReject.ok).toBe(false)
      if (!blockedReject.ok) {
        expect(blockedReject.error.code).toBe("proposal-not-found")
        expect(blockedReject.error.message).toContain("apply decision")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(2)
    } finally {
      cleanup(fixture)
    }
  })

  test("an expired duplicate apply preserves a foreign live claim and intent", async () => {
    const fixture = await createFixture({ ttlMs: 1_000 })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Base Note",
          content: "base body",
        }),
      )
      const pending = await submit(fixture, {
        operation: "update",
        id: note.id,
        content: "approved body",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const proposalOption = await Effect.runPromise(
        fixture.store.get(pending.proposalId),
      )
      if (Option.isNone(proposalOption)) {
        throw new Error("expected the proposal")
      }
      const proposal = proposalOption.value
      if (proposal.baseHash === undefined) {
        throw new Error("expected a base hash")
      }

      const claimed = await Effect.runPromise(
        fixture.claimStore.claim(pending.proposalId, "apply"),
      )
      expect(claimed.status).toBe("claimed")
      await Effect.runPromise(
        fixture.intentStore.put({
          proposalId: pending.proposalId,
          operation: proposal.operation,
          noteId: proposal.noteId,
          path: proposal.path,
          phase: "prepared",
          baseHash: proposal.baseHash,
          proposalHash: proposalFingerprint(proposal),
          preparedAt: new Date(FIXED_NOW).toISOString(),
        }),
      )

      fixture.clock.value = FIXED_NOW + 5_000
      const duplicate = await settle(
        Effect.runPromise(fixture.service.apply(pending.proposalId)),
      )
      expect(duplicate.ok).toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.error.code).toBe("proposal-expired")
      }

      const claimPath = join(
        fixture.claims,
        `${pending.proposalId}.json`,
      )
      const intentPath = join(
        fixture.intents,
        `${pending.proposalId}.json`,
      )
      expect(existsSync(claimPath)).toBe(true)
      expect(existsSync(intentPath)).toBe(true)

      const rejected = await settle(
        Effect.runPromise(fixture.service.reject(pending.proposalId)),
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("proposal-not-found")
        expect(rejected.error.message).toContain("apply decision")
      }
      expect(existsSync(claimPath)).toBe(true)
      expect(existsSync(intentPath)).toBe(true)

      // The paused apply resumes with its already-authorized write.
      const late = await Effect.runPromise(
        fixture.repository.update({
          id: note.id,
          content: "approved body",
          expectedContentHash: proposal.baseHash,
        }),
      )
      expect(late.body).toBe("approved body")
    } finally {
      cleanup(fixture)
    }
  })

  test("expired cleanup preserves a live claim and intent", async () => {
    const fixture = await createFixture({ ttlMs: 1_000 })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Cleanup Note",
          content: "base body",
        }),
      )
      const pending = await submit(fixture, {
        operation: "update",
        id: note.id,
        content: "approved body",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const proposalOption = await Effect.runPromise(
        fixture.store.get(pending.proposalId),
      )
      if (Option.isNone(proposalOption)) {
        throw new Error("expected the proposal")
      }
      const proposal = proposalOption.value
      if (proposal.baseHash === undefined) {
        throw new Error("expected a base hash")
      }
      await Effect.runPromise(
        fixture.claimStore.claim(pending.proposalId, "apply"),
      )
      await Effect.runPromise(
        fixture.intentStore.put({
          proposalId: pending.proposalId,
          operation: proposal.operation,
          noteId: proposal.noteId,
          path: proposal.path,
          phase: "prepared",
          baseHash: proposal.baseHash,
          proposalHash: proposalFingerprint(proposal),
          preparedAt: new Date(FIXED_NOW).toISOString(),
        }),
      )

      fixture.clock.value = FIXED_NOW + 5_000
      const removed = await Effect.runPromise(fixture.service.cleanupExpired())
      expect(removed).toContain(pending.proposalId)
      expect(existsSync(join(fixture.claims, `${pending.proposalId}.json`))).toBe(
        true,
      )
      expect(
        existsSync(join(fixture.intents, `${pending.proposalId}.json`)),
      ).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })
})
