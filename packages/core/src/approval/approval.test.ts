import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { MarkdownError, markdownError } from "../markdown/errors.js"
import {
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "../markdown/repository.js"
import {
  lineDiff,
  makeApprovalService,
  MAX_DIFF_CHARS,
  MAX_QUARANTINED_PROPOSALS,
  type ApprovalError,
  type ApprovalServiceShape,
  type McpWriteInput,
  type McpWriteResult,
} from "./index.js"
import { decidePolicy, resolveMcpWritePolicy } from "./policy.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly backup: string
  readonly repository: MarkdownNoteRepositoryShape
  readonly service: ApprovalServiceShape
  readonly pending: string
  readonly clock: { value: number }
}

const createFixture = async (
  options: {
    readonly policy?: "approval" | "direct-unsafe"
    readonly ttlMs?: number
    readonly maxPending?: number
    readonly refreshIndex?: () => Effect.Effect<void, MarkdownError>
  } = {},
): Promise<Fixture> => {
  const base = mkdtempSync("/tmp/opencode/slipmem-approval-")
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
  const service = await Effect.runPromise(
    makeApprovalService(repository, {
      now: () => clock.value,
      actor: "test-agent",
      env: {},
      ...(options.policy === undefined
        ? {}
        : { mcpWritePolicy: options.policy }),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxPending === undefined
        ? {}
        : { maxPending: options.maxPending }),
      ...(options.refreshIndex === undefined
        ? {}
        : { refreshIndex: options.refreshIndex }),
    }),
  )
  return {
    base,
    root,
    backup,
    repository,
    service,
    pending: join(root, ".state", "pending"),
    clock,
  }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const noteFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((name) => name.endsWith(".md"))

const pendingFiles = (directory: string): ReadonlyArray<string> =>
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

describe("approval policy", () => {
  test("implements the frozen MCP matrix and fails closed on unknown env", () => {
    expect(
      decidePolicy({
        caller: "mcp",
        operation: "create",
        nextType: "permanent",
      }),
    ).toEqual({ disposition: "pending", reason: "permanent-create" })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "update",
        currentType: "permanent",
        nextType: "permanent",
      }),
    ).toEqual({ disposition: "pending", reason: "permanent-update" })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "reclassify",
        currentType: "fleeting",
        nextType: "permanent",
      }),
    ).toEqual({ disposition: "pending", reason: "permanent-reclassify" })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "reclassify",
        currentType: "permanent",
        nextType: "literature",
      }),
    ).toEqual({ disposition: "pending", reason: "permanent-reclassify" })

    expect(
      decidePolicy({ caller: "mcp", operation: "delete", currentType: "fleeting" }),
    ).toEqual({ disposition: "pending", reason: "delete" })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "create",
        nextType: "fleeting",
      }),
    ).toEqual({ disposition: "direct", unsafeDirect: false })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "create",
        nextType: "literature",
      }),
    ).toEqual({ disposition: "direct", unsafeDirect: false })

    // The unsafe escape hatch does not bypass deletes.
    expect(
      decidePolicy({
        caller: "mcp",
        operation: "delete",
        currentType: "permanent",
        mcpWritePolicy: "direct-unsafe",
      }),
    ).toEqual({ disposition: "pending", reason: "delete" })

    expect(
      decidePolicy({
        caller: "mcp",
        operation: "create",
        nextType: "permanent",
        mcpWritePolicy: "direct-unsafe",
      }),
    ).toEqual({ disposition: "direct", unsafeDirect: true })

    expect(resolveMcpWritePolicy({})).toEqual({ policy: "approval" })
    expect(
      resolveMcpWritePolicy({ SLIPMEM_MCP_WRITE_POLICY: "direct" }),
    ).toEqual({ policy: "direct-unsafe" })
    const unknown = resolveMcpWritePolicy({
      SLIPMEM_MCP_WRITE_POLICY: "yolo",
    })
    expect(unknown.policy).toBe("approval")
    expect(unknown.warning).toContain("not recognized")
  })
})

describe("approval diff", () => {
  test("bounds hostile newline-heavy diffs", () => {
    const before = Array.from({ length: 1500 }, (_, index) => `old ${index}`).join("\n")
    const after = Array.from({ length: 1500 }, (_, index) => `new ${index}`).join("\n")
    const diff = lineDiff(before, after)
    expect(diff).toContain("diff too large")
    expect(diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 200)
  })
})

describe("approval lifecycle", () => {
  test("MCP permanent create stays pending, reviews, and applies atomically", async () => {
    const fixture = await createFixture()
    try {
      const result = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Durable lesson",
        content: "Approval is enforced by the server, not the prompt.",
        tags: ["Agent Memory"],
        actor: "agent-a",
      })

      expect(result.status).toBe("pending_approval")
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      expect(result.proposalId).toMatch(/^proposal-\d{14}-[0-9a-f]{8}$/)
      expect(noteFiles(fixture.root)).toEqual([])
      expect(pendingFiles(fixture.pending)).toHaveLength(1)

      const review = await Effect.runPromise(fixture.service.review())
      expect(review.proposals).toHaveLength(1)
      expect(review.proposals[0]!.summary).toContain("Create permanent note")
      expect(review.proposals[0]!.diff).toContain(
        "+Approval is enforced by the server, not the prompt.",
      )
      expect(review.proposals[0]!.stale).toBe(false)
      expect(review.proposals[0]!.proposal.actor).toBe("agent-a")

      const applied = await Effect.runPromise(
        fixture.service.apply(result.proposalId),
      )
      expect(applied.status).toBe("applied")
      if (applied.status !== "applied" || applied.operation === "delete") {
        throw new Error("expected an applied create")
      }
      expect(applied.note.metadata.type).toBe("permanent")
      expect(applied.note.metadata.provenance).toEqual({
        source: "mcp",
        actor: "agent-a",
      })
      expect(applied.note.metadata.tags).toEqual(["agent-memory"])
      expect(noteFiles(fixture.root)).toHaveLength(1)
      expect(pendingFiles(fixture.pending)).toHaveLength(0)

      const visible = await Effect.runPromise(fixture.repository.list())
      expect(visible).toHaveLength(1)

      const after = await Effect.runPromise(fixture.service.review())
      expect(after.proposals).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("fleeting and literature writes are direct with MCP provenance", async () => {
    const fixture = await createFixture()
    try {
      const fleeting = await submit(fixture, {
        operation: "create",
        type: "fleeting",
        title: "Inbox thought",
        content: "A quick capture.",
        actor: "agent-b",
      })
      expect(fleeting.status).toBe("direct")
      if (fleeting.status !== "direct") {
        throw new Error("expected direct")
      }
      expect(fleeting.note.metadata.provenance).toEqual({
        source: "mcp",
        actor: "agent-b",
      })

      const updated = await submit(fixture, {
        operation: "update",
        id: fleeting.note.id,
        content: "An updated quick capture.",
      })
      expect(updated.status).toBe("direct")

      const literature = await submit(fixture, {
        operation: "create",
        type: "literature",
        title: "Source note",
        content: "Recall should cite a source.",
        reference: "https://example.com/source",
      })
      expect(literature.status).toBe("direct")
      if (literature.status !== "direct") {
        throw new Error("expected direct")
      }
      expect(literature.note.metadata.reference).toBe("https://example.com/source")
      expect(pendingFiles(fixture.pending)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })

  test("permanent update and reclassification are pending; rejection changes nothing", async () => {
    const fixture = await createFixture()
    try {
      const permanent = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Current truth",
          content: "Original permanent body.",
        }),
      )
      const fleeting = await Effect.runPromise(
        fixture.repository.create({
          type: "fleeting",
          title: "Candidate",
          content: "Could become permanent.",
        }),
      )

      const update = await submit(fixture, {
        operation: "update",
        id: permanent.id,
        content: "Proposed permanent body.",
      })
      expect(update.status).toBe("pending_approval")
      if (update.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const stored = await Effect.runPromise(fixture.repository.get(permanent.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("Original permanent body.")
      }

      const rejected = await Effect.runPromise(
        fixture.service.reject(update.proposalId),
      )
      expect(rejected).toEqual({
        status: "rejected",
        proposalId: update.proposalId,
      })
      expect(noteFiles(fixture.root)).toHaveLength(2)
      expect(pendingFiles(fixture.pending)).toHaveLength(0)

      const reclassify = await submit(fixture, {
        operation: "update",
        id: fleeting.id,
        type: "permanent",
      })
      expect(reclassify.status).toBe("pending_approval")
      if (reclassify.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      expect(reclassify.summary).toContain("Reclassify")

      const applied = await Effect.runPromise(
        fixture.service.apply(reclassify.proposalId),
      )
      expect(applied.status).toBe("applied")
      if (applied.status !== "applied" || applied.operation === "delete") {
        throw new Error("expected applied reclassify")
      }
      expect(applied.operation).toBe("reclassify")
      expect(applied.note.metadata.type).toBe("permanent")
    } finally {
      cleanup(fixture)
    }
  })

  test("any MCP delete is pending, deletes nothing, and applies into a backup", async () => {
    const fixture = await createFixture()
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "fleeting",
          title: "Remove me",
          content: "Temporary.",
        }),
      )
      const result = await submit(fixture, {
        operation: "delete",
        id: note.id,
        actor: "agent-c",
      })
      expect(result.status).toBe("pending_approval")
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      expect(noteFiles(fixture.root)).toEqual([note.filename])
      expect(existsSync(note.path)).toBe(true)

      const review = await Effect.runPromise(fixture.service.review())
      expect(review.proposals[0]!.diff).toContain("-Temporary.")
      expect(review.proposals[0]!.stale).toBe(false)

      const applied = await Effect.runPromise(
        fixture.service.apply(result.proposalId),
      )
      expect(applied.status).toBe("applied")
      if (applied.status !== "applied" || applied.operation !== "delete") {
        throw new Error("expected an applied delete")
      }
      expect(existsSync(note.path)).toBe(false)
      expect(applied.backupPath.startsWith(fixture.backup)).toBe(true)
      expect(existsSync(applied.backupPath)).toBe(true)
      expect(noteFiles(fixture.root)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("a stale base hash is rejected without writing or deleting", async () => {
    const fixture = await createFixture()
    try {
      const permanent = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Shared note",
          content: "Version one.",
        }),
      )
      const update = await submit(fixture, {
        operation: "update",
        id: permanent.id,
        content: "Proposed version.",
      })
      expect(update.status).toBe("pending_approval")
      if (update.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      await Effect.runPromise(
        fixture.repository.update({
          id: permanent.id,
          content: "External edit wins.",
        }),
      )

      const error = await failure(fixture.service.apply(update.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("stale-base")
      }
      const stored = await Effect.runPromise(fixture.repository.get(permanent.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("External edit wins.")
      }
      expect(pendingFiles(fixture.pending)).toHaveLength(1)

      const review = await Effect.runPromise(fixture.service.review())
      expect(review.proposals[0]!.stale).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test("a stale delete is rejected and the note remains", async () => {
    const fixture = await createFixture()
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Protected",
          content: "Do not delete a changed note.",
        }),
      )
      const result = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      await Effect.runPromise(
        fixture.repository.update({ id: note.id, content: "Changed first." }),
      )

      const error = await failure(fixture.service.apply(result.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("stale-base")
      }
      expect(existsSync(note.path)).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test("apply rechecks the update base hash under the repository lock", async () => {
    const fixture = await createFixture()
    try {
      const permanent = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Racy update",
          content: "Base version.",
        }),
      )
      const update = await submit(fixture, {
        operation: "update",
        id: permanent.id,
        content: "Approved version.",
      })
      if (update.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      // The wrapper injects a concurrent repository write immediately before
      // the approved mutation reaches the repository. The pre-check already
      // passed, so only the under-lock CAS can catch this interleaving.
      let injected = false
      const racing = {
        ...fixture.repository,
        update: (input: Parameters<typeof fixture.repository.update>[0]) =>
          Effect.gen(function* () {
            if (!injected) {
              injected = true
              yield* fixture.repository.update({
                id: permanent.id,
                content: "Concurrent edit wins.",
              })
            }
            return yield* fixture.repository.update(input)
          }),
      }
      const service = await Effect.runPromise(
        makeApprovalService(racing, {
          now: () => fixture.clock.value,
          actor: "test-agent",
          env: {},
        }),
      )

      const error = await failure(service.apply(update.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("stale-base")
      }
      const stored = await Effect.runPromise(fixture.repository.get(permanent.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("Concurrent edit wins.")
      }
      expect(pendingFiles(fixture.pending)).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })

  test("apply rechecks the delete base hash under the repository lock", async () => {
    const fixture = await createFixture()
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Racy delete",
          content: "Keep a concurrent edit.",
        }),
      )
      const result = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      let injected = false
      const racing = {
        ...fixture.repository,
        delete: (
          id: string,
          options?: Parameters<typeof fixture.repository.delete>[1],
        ) =>
          Effect.gen(function* () {
            if (!injected) {
              injected = true
              yield* fixture.repository.update({
                id,
                content: "Concurrent edit survives the delete.",
              })
            }
            return yield* fixture.repository.delete(id, options)
          }),
      }
      const service = await Effect.runPromise(
        makeApprovalService(racing, {
          now: () => fixture.clock.value,
          actor: "test-agent",
          env: {},
        }),
      )

      const error = await failure(service.apply(result.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("stale-base")
      }
      expect(existsSync(note.path)).toBe(true)
      const stored = await Effect.runPromise(fixture.repository.get(note.id))
      expect(stored._tag).toBe("Some")
      if (stored._tag === "Some") {
        expect(stored.value.body).toBe("Concurrent edit survives the delete.")
      }
      expect(pendingFiles(fixture.pending)).toHaveLength(1)
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects future-dated and over-long proposal timing", async () => {
    const fixture = await createFixture({ ttlMs: 60_000 })
    try {
      const first = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Future dated",
        content: "A proposal must expire on the local clock.",
      })
      if (first.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const firstPath = join(fixture.pending, `${first.proposalId}.json`)
      const firstRaw = JSON.parse(readFileSync(firstPath, "utf8")) as Record<
        string,
        unknown
      >
      writeFileSync(
        firstPath,
        JSON.stringify({
          ...firstRaw,
          createdAt: "2099-01-01T00:00:00Z",
          expiresAt: "2099-01-02T00:00:00Z",
        }),
        "utf8",
      )

      const second = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Long expiry",
        content: "A proposal cannot outlive its configured TTL.",
      })
      if (second.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const secondPath = join(fixture.pending, `${second.proposalId}.json`)
      const secondRaw = JSON.parse(readFileSync(secondPath, "utf8")) as Record<
        string,
        unknown
      >
      writeFileSync(
        secondPath,
        JSON.stringify({
          ...secondRaw,
          expiresAt: "2099-01-01T00:00:00Z",
        }),
        "utf8",
      )

      const review = await Effect.runPromise(fixture.service.review())
      expect(review.proposals).toHaveLength(0)
      expect(review.invalid).toHaveLength(2)

      const futureError = await failure(fixture.service.apply(first.proposalId))
      expect(futureError._tag).toBe("ApprovalError")
      if (futureError._tag === "ApprovalError") {
        expect(futureError.code).toBe("invalid-proposal")
      }
      const expiryError = await failure(fixture.service.apply(second.proposalId))
      expect(expiryError._tag).toBe("ApprovalError")
      if (expiryError._tag === "ApprovalError") {
        expect(expiryError.code).toBe("invalid-proposal")
      }
      expect(noteFiles(fixture.root)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("quarantines old malformed proposals with a bounded directory", async () => {
    const fixture = await createFixture({ ttlMs: 1_000 })
    try {
      mkdirSync(fixture.pending, { recursive: true })
      const old = new Date(Date.parse("2026-11-17T20:00:00Z"))
      for (let index = 0; index < MAX_QUARANTINED_PROPOSALS + 5; index++) {
        const path = join(
          fixture.pending,
          `proposal-20261117200000-bad${String(index).padStart(5, "0")}.json`,
        )
        writeFileSync(path, "{not json", "utf8")
        utimesSync(path, old, old)
      }

      // Cleanup is deliberately capped per run; run it until the backlog is
      // drained, then verify truncation retention is bounded as well.
      for (let pass = 0; pass < 10; pass++) {
        await Effect.runPromise(fixture.service.review())
      }

      expect(pendingFiles(fixture.pending)).toEqual([])
      const quarantine = join(
        fixture.root,
        ".state",
        "quarantine",
        "pending",
      )
      expect(pendingFiles(quarantine).length).toBeLessThanOrEqual(
        MAX_QUARANTINED_PROPOSALS,
      )
      expect(pendingFiles(quarantine).length).toBeGreaterThan(0)
      expect(noteFiles(fixture.root)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("expired proposals are cleaned by review and cannot be applied", async () => {
    const fixture = await createFixture({ ttlMs: 60_000 })
    try {
      const result = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Short lived",
        content: "Expires quickly in this test.",
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      fixture.clock.value += 61_000
      const review = await Effect.runPromise(fixture.service.review())
      expect(review.removed).toEqual([result.proposalId])
      expect(review.proposals).toHaveLength(0)
      expect(pendingFiles(fixture.pending)).toHaveLength(0)
      expect(noteFiles(fixture.root)).toEqual([])

      const error = await failure(fixture.service.apply(result.proposalId))
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("proposal-not-found")
      }
    } finally {
      cleanup(fixture)
    }
  })

  test("bounds the pending queue and reports it actionably", async () => {
    const fixture = await createFixture({ maxPending: 2 })
    try {
      for (const title of ["One", "Two"]) {
        const result = await submit(fixture, {
          operation: "create",
          type: "permanent",
          title,
          content: `Body for ${title}.`,
        })
        expect(result.status).toBe("pending_approval")
      }

      const error = await failure(
        fixture.service.submitMcp({
          operation: "create",
          type: "permanent",
          title: "Three",
          content: "Body for Three.",
        }),
      )
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("proposal-queue-full")
        expect(error.message).toContain("maximum 2")
      }
      expect(pendingFiles(fixture.pending)).toHaveLength(2)
      expect(noteFiles(fixture.root)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("tampered proposal files are reported, never applied", async () => {
    const fixture = await createFixture()
    try {
      const result = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Valid first",
        content: "A valid proposal.",
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const badPath = join(fixture.pending, "proposal-20261117213000-deadbeef.json")
      writeFileSync(
        badPath,
        JSON.stringify({
          id: "proposal-20261117213000-deadbeef",
          operation: "create",
          noteId: "../../etc/passwd",
          path: "/etc/passwd",
          createdAt: "2026-11-17T21:30:00Z",
          expiresAt: "2026-11-24T21:30:00Z",
          source: "mcp",
          summary: "poisoned",
          content: "x",
        }),
        "utf8",
      )

      const review = await Effect.runPromise(fixture.service.review())
      expect(review.invalid.length).toBeGreaterThan(0)
      expect(review.proposals).toHaveLength(1)

      const error = await failure(
        fixture.service.apply("proposal-20261117213000-deadbeef"),
      )
      expect(error._tag).toBe("ApprovalError")
      if (error._tag === "ApprovalError") {
        expect(error.code).toBe("invalid-proposal")
      }
      expect(existsSync("/etc/passwd")).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test("unsafe direct mode records provenance but still gates deletes", async () => {
    const fixture = await createFixture({ policy: "direct-unsafe" })
    try {
      const created = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Unsafe direct",
        content: "Trusted automation wrote this.",
        actor: "trusted-bot",
      })
      expect(created.status).toBe("direct")
      if (created.status !== "direct") {
        throw new Error("expected direct")
      }
      expect(created.unsafeDirect).toBe(true)
      expect(created.note.metadata.provenance).toEqual({
        source: "mcp-direct",
        actor: "trusted-bot",
      })
      expect(noteFiles(fixture.root)).toHaveLength(1)

      const deletion = await submit(fixture, {
        operation: "delete",
        id: created.note.id,
      })
      expect(deletion.status).toBe("pending_approval")
      expect(existsSync(created.note.path)).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test("stores proposals as local state, never as note files", async () => {
    const fixture = await createFixture()
    try {
      const result = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Local only",
        content: "Pending records are not notes.",
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const pendingPath = join(fixture.pending, `${result.proposalId}.json`)
      expect(existsSync(pendingPath)).toBe(true)
      const raw = JSON.parse(readFileSync(pendingPath, "utf8")) as {
        source: string
        operation: string
      }
      expect(raw.source).toBe("mcp")
      expect(raw.operation).toBe("create")
      expect(noteFiles(fixture.root)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("refreshes the derived index after each durable approval", async () => {
    let refreshes = 0
    const fixture = await createFixture({
      refreshIndex: () => {
        refreshes++
        return Effect.void
      },
    })
    try {
      const note = await Effect.runPromise(
        fixture.repository.create({
          type: "permanent",
          title: "Refresh target",
          content: "Base body.",
        }),
      )

      const create = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Indexed on approval",
        content: "No search should be needed to index this note.",
      })
      if (create.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const created = await Effect.runPromise(fixture.service.apply(create.proposalId))
      expect(created.index).toEqual({ status: "refreshed" })
      expect(refreshes).toBe(1)

      const update = await submit(fixture, {
        operation: "update",
        id: note.id,
        content: "Updated body.",
      })
      if (update.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const updated = await Effect.runPromise(fixture.service.apply(update.proposalId))
      expect(updated.index).toEqual({ status: "refreshed" })
      expect(refreshes).toBe(2)

      const deletion = await submit(fixture, {
        operation: "delete",
        id: note.id,
      })
      if (deletion.status !== "pending_approval") {
        throw new Error("expected pending")
      }
      const deleted = await Effect.runPromise(fixture.service.apply(deletion.proposalId))
      expect(deleted.index).toEqual({ status: "refreshed" })
      expect(refreshes).toBe(3)
    } finally {
      cleanup(fixture)
    }
  })

  test("keeps a durable note and warns when the index cache cannot refresh", async () => {
    const fixture = await createFixture({
      refreshIndex: () =>
        Effect.fail(
          markdownError({
            area: "index",
            code: "index-error",
            path: "/tmp/unavailable-index",
            message: "The index cache directory is unavailable.",
          }),
        ),
    })
    try {
      const result = await submit(fixture, {
        operation: "create",
        type: "permanent",
        title: "Durable despite cache",
        content: "The note must survive a failed cache refresh.",
      })
      if (result.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const applied = await Effect.runPromise(fixture.service.apply(result.proposalId))
      expect(applied.status).toBe("applied")
      expect(applied.index.status).toBe("failed")
      expect(applied.index.warning).toContain("index cache directory is unavailable")
      expect(applied.index.warning).toContain("check --rebuild-index")

      const visible = await Effect.runPromise(fixture.repository.list())
      expect(visible.map((note) => note.title)).toEqual([
        "Durable despite cache",
      ])
      expect(pendingFiles(fixture.pending)).toHaveLength(0)
    } finally {
      cleanup(fixture)
    }
  })
})
