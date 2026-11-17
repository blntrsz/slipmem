import { afterEach, describe, expect, test } from "bun:test"
import {
  makeApprovalService,
  makeMarkdownNoteRepository,
  type ApprovalServiceShape,
  type MarkdownNoteRepositoryShape,
} from "@slipmem/core"
import { Effect } from "effect"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface Setup {
  readonly base: string
  readonly root: string
  readonly env: Record<string, string>
  readonly repository: MarkdownNoteRepositoryShape
  readonly approval: ApprovalServiceShape
}

interface ReviewResult {
  readonly ok: boolean
  readonly pending: number
  readonly report: {
    readonly proposals: ReadonlyArray<{
      readonly summary: string
      readonly diff: string
      readonly stale: boolean
      readonly expired: boolean
      readonly proposal: {
        readonly id: string
        readonly operation: string
        readonly noteId?: string
      }
    }>
  }
}

interface ApprovalResult {
  readonly ok: boolean
  readonly application: {
    readonly status: string
    readonly proposalId: string
    readonly operation: string
    readonly noteId: string
    readonly backupPath?: string
    readonly note?: { readonly id: string; readonly content: string }
  }
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const setup = async (): Promise<Setup> => {
  const base = makeTempBase()
  cleanup.push(base)
  const root = join(base, ".slipmem")
  const env = {
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_STATE_HOME: join(base, "state"),
  }
  const init = await runCliProcess(["init", "--dir", root, "--json"], { env })
  expect(init.code).toBe(0)

  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({ root, backupDir: join(base, "trash") }),
  )
  const approval = await Effect.runPromise(
    makeApprovalService(repository, { env: {} }),
  )
  return { base, root, env, repository, approval }
}

const run = (setupValue: Setup, args: ReadonlyArray<string>) => {
  const [command, ...rest] = args
  return runCliProcess([command!, "--dir", setupValue.root, ...rest], {
    env: setupValue.env,
  })
}

const proposalId = async (
  setupValue: Setup,
  input: Parameters<ApprovalServiceShape["submitMcp"]>[0],
): Promise<string> => {
  const result = await Effect.runPromise(setupValue.approval.submitMcp(input))
  expect(result.status).toBe("pending_approval")
  if (result.status !== "pending_approval") {
    throw new Error("Expected a pending proposal")
  }
  return result.proposalId
}

describe("slipmem review, approve, and reject", () => {
  test("reviews a pending permanent proposal and applies it atomically", async () => {
    const setupValue = await setup()
    const id = await proposalId(setupValue, {
      operation: "create",
      type: "permanent",
      title: "Agent memory proposal",
      content: "A permanent note proposed by an agent.",
      topics: ["agent-memory"],
      actor: "test-agent",
    })

    const review = await run(setupValue, ["review", "--json"])
    expect(review.code).toBe(0)
    const reviewed = parseJson<ReviewResult>(review.stdout)
    expect(reviewed.pending).toBe(1)
    expect(reviewed.report.proposals[0]!.proposal).toMatchObject({
      id,
      operation: "create",
    })
    expect(reviewed.report.proposals[0]!.summary).toContain("permanent")
    expect(reviewed.report.proposals[0]!.diff).toContain(
      "+A permanent note proposed by an agent.",
    )
    expect(reviewed.report.proposals[0]!.stale).toBe(false)

    // Review never writes the note.
    const before = await run(setupValue, ["list", "--json"])
    expect(parseJson<{ count: number }>(before.stdout).count).toBe(0)

    const approved = await run(setupValue, ["approve", id, "--json"])
    expect(approved.code).toBe(0)
    const application = parseJson<ApprovalResult>(approved.stdout).application
    expect(application).toMatchObject({
      status: "applied",
      operation: "create",
    })
    expect(application.note?.content).toBe(
      "A permanent note proposed by an agent.",
    )

    const shown = await run(setupValue, [
      "show",
      application.noteId,
      "--json",
    ])
    expect(
      parseJson<{ note: { content: string } }>(shown.stdout).note.content,
    ).toBe("A permanent note proposed by an agent.")

    const after = await run(setupValue, ["review", "--json"])
    expect(parseJson<ReviewResult>(after.stdout).pending).toBe(0)
  })

  test("reject removes the proposal without creating or changing a note", async () => {
    const setupValue = await setup()
    const id = await proposalId(setupValue, {
      operation: "create",
      type: "permanent",
      title: "Rejected proposal",
      content: "This should never become a note.",
      actor: "test-agent",
    })

    const rejected = await run(setupValue, ["reject", id, "--json"])
    expect(rejected.code).toBe(0)
    expect(
      parseJson<{ rejection: { status: string; proposalId: string } }>(
        rejected.stdout,
      ).rejection,
    ).toEqual({ status: "rejected", proposalId: id })

    const list = await run(setupValue, ["list", "--json"])
    expect(parseJson<{ count: number }>(list.stdout).count).toBe(0)
    const review = await run(setupValue, ["review", "--json"])
    expect(parseJson<ReviewResult>(review.stdout).pending).toBe(0)
  })

  test("refuses a stale proposal without overwriting the changed note", async () => {
    const setupValue = await setup()
    const created = await run(setupValue, [
      "new",
      "--type",
      "permanent",
      "--title",
      "Base note",
      "--content",
      "Original base body.",
      "--json",
    ])
    const noteId = parseJson<{ note: { id: string } }>(created.stdout).note.id
    const id = await proposalId(setupValue, {
      operation: "update",
      id: noteId,
      content: "Proposed replacement body.",
      actor: "test-agent",
    })

    await Effect.runPromise(
      setupValue.repository.update({
        id: noteId,
        content: "Changed by a human before approval.",
      }),
    )

    const review = await run(setupValue, ["review", "--json"])
    expect(parseJson<ReviewResult>(review.stdout).report.proposals[0]!.stale).toBe(
      true,
    )

    const approved = await run(setupValue, ["approve", id, "--json"])
    expect(approved.code).toBe(1)
    expect(
      parseJson<{ error: { code: string } }>(approved.stderr).error.code,
    ).toBe("stale-base")

    const shown = await run(setupValue, ["show", noteId, "--json"])
    expect(
      parseJson<{ note: { content: string } }>(shown.stdout).note.content,
    ).toBe("Changed by a human before approval.")
  })

  test("applies a delete proposal through the repository backup path", async () => {
    const setupValue = await setup()
    const created = await run(setupValue, [
      "new",
      "--type",
      "fleeting",
      "--title",
      "Delete target",
      "--content",
      "Remove me safely.",
      "--json",
    ])
    const noteId = parseJson<{ note: { id: string } }>(created.stdout).note.id
    const id = await proposalId(setupValue, {
      operation: "delete",
      id: noteId,
      actor: "test-agent",
    })

    const approved = await run(setupValue, ["approve", id, "--json"])
    expect(approved.code).toBe(0)
    const application = parseJson<ApprovalResult>(approved.stdout).application
    expect(application).toMatchObject({
      operation: "delete",
      noteId,
    })
    expect(application.backupPath).toContain("trash")

    const missing = await run(setupValue, ["show", noteId, "--json"])
    expect(missing.code).toBe(1)
  })

  test("reports a missing proposal as a typed failure", async () => {
    const setupValue = await setup()
    const result = await run(setupValue, [
      "approve",
      "proposal-20990101000000-deadbeef",
      "--json",
    ])
    expect(result.code).toBe(1)
    expect(
      parseJson<{ error: { code: string } }>(result.stderr).error.code,
    ).toBe("proposal-not-found")
  }, 30000)
})
