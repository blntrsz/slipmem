import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeMarkdownNoteRepository } from "../markdown/repository.js"
import {
  makeApprovalService,
  type ApprovalError,
  type ApprovalServiceShape,
  type McpWriteInput,
} from "./index.js"

const FIXED_NOW = Date.parse("2026-11-17T21:30:00Z")

interface Fixture {
  readonly base: string
  readonly root: string
  readonly outside: string
  readonly service: ApprovalServiceShape
  readonly clock: { value: number }
}

const createFixture = async (options: { readonly ttlMs?: number } = {}): Promise<Fixture> => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-proposal-safety-"))
  const root = join(base, "notes")
  const outside = join(base, "outside")
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const clock = { value: FIXED_NOW }
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir: join(base, "backups"),
      now: () => clock.value,
    }),
  )
  const service = await Effect.runPromise(
    makeApprovalService(repository, {
      now: () => clock.value,
      env: {},
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
  )
  return { base, root, outside, service, clock }
}

const cleanup = (fixture: Fixture): void => {
  rmSync(fixture.base, { recursive: true, force: true })
}

const failure = async <A>(
  effect: Effect.Effect<A, ApprovalError>,
): Promise<ApprovalError> => {
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

const permanentCreate: McpWriteInput = {
  operation: "create",
  type: "permanent",
  title: "Safe state",
  content: "This must stay inside the repository.",
}

const jsonFiles = (directory: string): ReadonlyArray<string> =>
  existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".json"))
    : []

describe("proposal store state path safety", () => {
  test("rejects a symlinked .state/pending instead of writing outside", async () => {
    const fixture = await createFixture()
    try {
      mkdirSync(join(fixture.root, ".state"), { recursive: true })
      symlinkSync(
        fixture.outside,
        join(fixture.root, ".state", "pending"),
      )

      const error = await failure(fixture.service.submitMcp(permanentCreate))

      expect(error.code).toBe("proposal-write-failed")
      expect(jsonFiles(fixture.outside)).toEqual([])
      expect(jsonFiles(join(fixture.root, ".state", "pending"))).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("rejects a symlinked .state itself before creating proposal state", async () => {
    const fixture = await createFixture()
    try {
      symlinkSync(fixture.outside, join(fixture.root, ".state"))

      const error = await failure(fixture.service.submitMcp(permanentCreate))

      expect(error.code).toBe("proposal-write-failed")
      expect(readdirSync(fixture.outside)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("apply refuses to read proposals through a symlinked pending directory", async () => {
    const fixture = await createFixture()
    try {
      mkdirSync(join(fixture.root, ".state"), { recursive: true })
      symlinkSync(
        fixture.outside,
        join(fixture.root, ".state", "pending"),
      )
      const proposalId = "proposal-20261117213000-deadbeef"
      const outsideProposal = join(fixture.outside, `${proposalId}.json`)
      writeFileSync(outsideProposal, "{not json", "utf8")

      const error = await failure(fixture.service.apply(proposalId))

      expect(error.code).toBe("proposal-write-failed")
      expect(existsSync(outsideProposal)).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test("refuses to read a symlinked proposal file", async () => {
    const fixture = await createFixture()
    try {
      const pending = join(fixture.root, ".state", "pending")
      mkdirSync(pending, { recursive: true })
      const proposalId = "proposal-20261117213000-deadbeef"
      const outsideProposal = join(fixture.outside, "proposal.json")
      writeFileSync(outsideProposal, '{"id":"not-a-proposal"}', "utf8")
      symlinkSync(outsideProposal, join(pending, `${proposalId}.json`))

      const error = await failure(fixture.service.apply(proposalId))

      expect(error.code).toBe("invalid-proposal")
      expect(error.message).toContain("symbolic links")
      expect(readFileSync(outsideProposal, "utf8")).toBe(
        '{"id":"not-a-proposal"}',
      )
    } finally {
      cleanup(fixture)
    }
  })

  test("apply refuses a symlinked approval-claim directory", async () => {
    const fixture = await createFixture()
    try {
      mkdirSync(join(fixture.root, ".state"), { recursive: true })
      symlinkSync(
        fixture.outside,
        join(fixture.root, ".state", "approval-claim"),
      )
      const pending = await Effect.runPromise(
        fixture.service.submitMcp(permanentCreate),
      )
      if (pending.status !== "pending_approval") {
        throw new Error("expected pending")
      }

      const error = await failure(fixture.service.apply(pending.proposalId))

      expect(error.code).toBe("proposal-write-failed")
      expect(readdirSync(fixture.outside)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })

  test("quarantine refuses a symlinked quarantine directory", async () => {
    const fixture = await createFixture({ ttlMs: 1_000 })
    try {
      const pending = join(fixture.root, ".state", "pending")
      mkdirSync(pending, { recursive: true })
      symlinkSync(
        fixture.outside,
        join(fixture.root, ".state", "quarantine"),
      )

      const malformed = join(
        pending,
        "proposal-20261117200000-bad00000.json",
      )
      writeFileSync(malformed, "{not json", "utf8")
      const old = new Date(Date.parse("2026-11-17T20:00:00Z"))
      utimesSync(malformed, old, old)

      const report = await Effect.runPromise(fixture.service.review())

      expect(report.quarantined).toEqual([])
      expect(report.invalid.length).toBeGreaterThan(0)
      expect(existsSync(malformed)).toBe(true)
      expect(jsonFiles(fixture.outside)).toEqual([])
    } finally {
      cleanup(fixture)
    }
  })
})
