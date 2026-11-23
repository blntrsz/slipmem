import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MarkdownError, markdownError } from "../markdown/errors.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  approvalError,
  makeApplyIntentStore,
  makeApprovalService,
  makeProposalStore,
  type ApplyIntentStoreShape,
  type ApprovalError,
  type ApprovalServiceShape,
  type McpWriteInput,
  type McpWriteResult,
  type ProposalStoreShape,
} from "./index.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly backup: string
  readonly pending: string
  readonly intents: string
  readonly clock: { value: number }
  readonly repository: MarkdownNoteRepositoryShape
  readonly store: ProposalStoreShape
  readonly intentStore: ApplyIntentStoreShape
  readonly service: ApprovalServiceShape
}

interface FixtureOptions {
  readonly repository?: (
    repository: MarkdownNoteRepositoryShape,
  ) => MarkdownNoteRepositoryShape
  readonly store?: (store: ProposalStoreShape) => ProposalStoreShape
  readonly intentStore?: (
    store: ApplyIntentStoreShape,
  ) => ApplyIntentStoreShape
  readonly refreshIndex?: () => Effect.Effect<void, MarkdownError>
  readonly ttlMs?: number
}

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-approval-apply-"))
  const root = join(base, ".slipmem")
  const backup = join(base, "backups")
  mkdirSync(root, { recursive: true })
  const clock = { value: FIXED_NOW }
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir: backup,
      now: () => clock.value,
    }),
  )
  const baseStore = await Effect.runPromise(
    makeProposalStore({ root, now: () => clock.value }),
  )
  const baseIntentStore = await Effect.runPromise(
    makeApplyIntentStore({ root }),
  )
  const store = options.store?.(baseStore) ?? baseStore
  const intentStore = options.intentStore?.(baseIntentStore) ?? baseIntentStore
  const wrappedRepository = options.repository?.(repository) ?? repository
  const service = await Effect.runPromise(
    makeApprovalService(wrappedRepository, {
      now: () => clock.value,
      actor: "test-agent",
      env: {},
      store,
      intentStore,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.refreshIndex === undefined
        ? {}
        : { refreshIndex: options.refreshIndex }),
    }),
  )
  return {
    base,
    root,
    backup,
    pending: join(root, ".state", "pending"),
    intents: join(root, ".state", "apply-intent"),
    clock,
    repository: wrappedRepository,
    store,
    intentStore,
    service,
  }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((name) => name.endsWith(".md"))

const jsonFiles = (directory: string): ReadonlyArray<string> =>
  existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".json"))
    : []

const submit = (
  fixture: Fixture,
  input: McpWriteInput,
): Promise<McpWriteResult> =>
  Effect.runPromise(fixture.service.submitMcp(input))

const failure = async <A>(
  effect: Effect.Effect<A, ApprovalError | MarkdownError>,
): Promise<ApprovalError | MarkdownError> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected a typed failure")
  }
  const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (fail === undefined || fail._tag !== "Fail") {
    throw new Error("Expected a typed failure reason")
  }
  return fail.error
}

describe("approval apply boundary", () => {
  test("create uses the exact-ID primitive and never compensates with a delete", async () => {
    const fixture = await createFixture()
    try {
      const pending = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Racing Create",
        content: "Proposed occupant.",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      let injected = false
      let deletes = 0
      const racing: MarkdownNoteRepositoryShape = {
        ...fixture.repository,
        create: (input) =>
          Effect.gen(function* () {
            if (!injected && input.id !== undefined) {
              injected = true
              yield* fixture.repository.create({
                type: "fleeting",
                title: "Racing Create",
                content: "External occupant wins.",
              })
            }
            return yield* fixture.repository.create(input)
          }),
        delete: (id, options) => {
          deletes++
          return fixture.repository.delete(id, options)
        },
      }
      const service = await Effect.runPromise(
        makeApprovalService(racing, {
          now: () => fixture.clock.value,
          actor: "test-agent",
          env: {},
          store: fixture.store,
          intentStore: fixture.intentStore,
        }),
      )

      const error = await failure(service.apply(pending.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("target-exists")
        expect(error.message).toContain("exact-ID")
      }

      expect(deletes).toBe(0)
      expect(noteFiles(fixture.root)).toEqual(["racing-create.md"])
      expect(jsonFiles(fixture.pending)).toHaveLength(1)

      const stored = await Effect.runPromise(
        fixture.repository.get("racing-create"),
      )
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("External occupant wins.")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("a verified update with failed cleanup returns applied and retries idempotently", async () => {
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
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Cleanup Target",
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

      const first = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(first.status).toBe("applied")
      expect(first.cleanup?.status).toBe("pending")
      expect(first.cleanup?.warning).toContain("could not be removed")
      if (first.operation !== "delete") {
        expect(first.note.body).toBe("Approved body.")
      }

      const afterFirst = await Effect.runPromise(
        fixture.repository.get(note.id),
      )
      expect(afterFirst._tag).toBe("Some")
      if (afterFirst._tag !== "Some") {
        throw new Error("expected the note")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(1)

      const second = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(second.status).toBe("applied")
      expect(second.cleanup).toBeUndefined()
      if (second.operation !== "delete") {
        expect(second.note.contentHash).toBe(afterFirst.value.contentHash)
      }

      const afterSecond = await Effect.runPromise(
        fixture.repository.get(note.id),
      )
      expect(afterSecond._tag).toBe("Some")
      if (afterSecond._tag === "Some") {
        expect(afterSecond.value.contentHash).toBe(afterFirst.value.contentHash)
        expect(afterSecond.value.body).toBe("Approved body.")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.intents)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a leftover applied intent reconciles after the proposal was already removed", async () => {
    const fixture = await createFixture({
      intentStore: (store) => {
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
                        code: "apply-failed",
                        proposalId,
                        message: "simulated intent cleanup failure",
                      }),
                    ),
                  ),
                )
              : store.remove(proposalId),
        }
      },
    })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Intent Leftover",
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

      const first = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(first.status).toBe("applied")
      expect(first.cleanup?.status).toBe("pending")
      expect(first.cleanup?.warning).toContain("apply intent could not be removed")
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.intents)).toHaveLength(1)

      const afterFirst = await Effect.runPromise(
        fixture.repository.get(note.id),
      )
      expect(afterFirst._tag).toBe("Some")
      if (afterFirst._tag !== "Some") {
        throw new Error("expected the note")
      }

      const second = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(second.status).toBe("applied")
      expect(second.cleanup).toBeUndefined()
      if (second.operation !== "delete") {
        expect(second.note.contentHash).toBe(afterFirst.value.contentHash)
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.intents)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("recovers when the intent cannot be marked applied after the note write", async () => {
    const fixture = await createFixture({
      intentStore: (store) => {
        let puts = 0
        return {
          ...store,
          put: (intent) => {
            puts++
            return puts === 2
              ? Effect.fail(
                  approvalError({
                    code: "apply-failed",
                    proposalId: intent.proposalId,
                    message: "simulated intent write failure",
                  }),
                )
              : store.put(intent)
          },
        }
      },
    })
    try {
      const pending = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Intent Recovery",
        content: "Durable before the intent update.",
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const first = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(first.status).toBe("applied")
      expect(first.cleanup?.status).toBe("pending")
      expect(first.cleanup?.warning).toContain("could not be marked applied")
      expect(noteFiles(fixture.root)).toEqual(["intent-recovery.md"])
      expect(jsonFiles(fixture.pending)).toHaveLength(1)
      expect(jsonFiles(fixture.intents)).toHaveLength(1)

      const rawIntent = JSON.parse(
        readFileSync(
          join(fixture.intents, `${pending.proposalId}.json`),
          "utf8",
        ),
      ) as { phase: string }
      expect(rawIntent.phase).toBe("prepared")

      const before = await Effect.runPromise(
        fixture.repository.get("intent-recovery"),
      )
      const second = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(second.status).toBe("applied")
      expect(second.cleanup).toBeUndefined()

      const after = await Effect.runPromise(
        fixture.repository.get("intent-recovery"),
      )
      expect(after._tag).toBe("Some")
      if (before._tag === "Some" && after._tag === "Some") {
        expect(after.value.contentHash).toBe(before.value.contentHash)
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
      expect(jsonFiles(fixture.intents)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a prepared intent turns a competing edit into an explicit conflict", async () => {
    const fixture = await createFixture({
      repository: (repository) => {
        let failNext = true
        return {
          ...repository,
          update: (input) =>
            failNext
              ? Effect.sync(() => {
                  failNext = false
                }).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      markdownError({
                        area: "repository",
                        code: "write-failed",
                        path: repository.root,
                        message: "simulated crash before the write",
                      }),
                    ),
                  ),
                )
              : repository.update(input),
        }
      },
    })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Conflict Target",
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

      const first = await failure(fixture.service.apply(pending.proposalId))
      expect(first._tag).toBe("ApprovalError")
      if (first._tag === "ApprovalError") {
        expect(first.code).toBe("repository-failure")
      }
      expect(jsonFiles(fixture.intents)).toHaveLength(1)

      await Effect.runPromise(
        fixture.repository.update({
          id: note.id,
          content: "External edit wins.",
        }),
      )

      const second = await failure(fixture.service.apply(pending.proposalId))
      expect(second._tag).toBe("ApprovalError")
      if (second._tag === "ApprovalError") {
        expect(second.code).toBe("apply-conflict")
        expect(second.message).toContain("differs from both")
      }

      const stored = await Effect.runPromise(fixture.repository.get(note.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("External edit wins.")
      }
      expect(jsonFiles(fixture.pending)).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })

  test("delete cleanup retries with the same backup and never deletes twice", async () => {
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
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Delete Target",
          content: "Remove me once.",
        }),
      )
      const pending = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const first = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(first.operation).toBe("delete")
      if (first.operation !== "delete") {
        throw new Error("expected delete")
      }
      expect(first.cleanup?.status).toBe("pending")
      expect(existsSync(note.path)).toBe(false)
      expect(readdirSync(fixture.backup).filter((name) => name.endsWith(".md"))).toHaveLength(1)

      const second = await Effect.runPromise(
        fixture.service.apply(pending.proposalId),
      )
      expect(second.operation).toBe("delete")
      if (second.operation !== "delete") {
        throw new Error("expected delete")
      }
      expect(second.backupPath).toBe(first.backupPath)
      expect(second.cleanup).toBeUndefined()
      expect(existsSync(note.path)).toBe(false)
      expect(readdirSync(fixture.backup).filter((name) => name.endsWith(".md"))).toHaveLength(1)
      expect(jsonFiles(fixture.pending)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("a prepared delete whose backup path was not recorded is explicitly unknown", async () => {
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
          title: "Unrecorded Backup",
          content: "Deleted before the intent update.",
        }),
      )
      const pending = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const first = await failure(fixture.service.apply(pending.proposalId))
      expect(first._tag).toBe("ApprovalError")
      if (first._tag === "ApprovalError") {
        expect(first.code).toBe("repository-failure")
      }
      expect(existsSync(note.path)).toBe(false)

      const second = await failure(fixture.service.apply(pending.proposalId))
      expect(second._tag).toBe("ApprovalError")
      if (second._tag === "ApprovalError") {
        expect(second.code).toBe("apply-unknown")
        expect(second.message).toContain("backup path")
      }
      expect(existsSync(note.path)).toBe(false)
      expect(jsonFiles(fixture.pending)).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })
})
