import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliContext } from "./context.js"
import { runInitiativeCli } from "./initiative-cli.js"

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

interface Fixture {
  readonly base: string
  readonly root: string
  readonly context: CliContext
  readonly stdout: string[]
  readonly stderr: string[]
}

const fixture = (): Fixture => {
  const base = mkdtempSync(join(tmpdir(), "slipmem-initiative-cli-"))
  cleanup.push(base)
  const root = join(base, ".slipmem")
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, "src"), { recursive: true })
  mkdirSync(join(base, "docs"), { recursive: true })
  writeFileSync(
    join(base, "src/feature.ts"),
    "export const answer = (): number => 42\n",
    "utf8",
  )
  writeFileSync(
    join(base, "docs/scope.md"),
    "# Initiative scope\n\nExpose a minimal initiative command path.\n",
    "utf8",
  )
  const stdout: string[] = []
  const stderr: string[] = []
  const context: CliContext = {
    cwd: base,
    env: { SLIPMEM_DIR: root },
    io: {
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
    },
    now: () => Date.parse("2026-11-22T13:00:00Z"),
    stdinIsTTY: false,
    readStdin: async () => "",
    openEditor: async () => 0,
  }
  return { base, root, context, stdout, stderr }
}

const json = <A>(lines: ReadonlyArray<string>): A =>
  JSON.parse(lines.join("")) as A

const initializeGit = (base: string): void => {
  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", args, {
      cwd: base,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  git("init", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  git("add", "src", "docs")
  git("commit", "-m", "initial")
}

const draftWithPin = (
  pin: Record<string, unknown>,
): Record<string, unknown> => ({
  title: "Initiative command path",
  scope: {
    summary: "Use a nested initiative record, not a note.",
    intendedBehavior: "Provide pin, create, verify, scope, and promote.",
    sourcePath: "docs/scope.md",
  },
  milestones: [
    {
      title: "Command path",
      intendedBehavior: "The minimal path is executable and honest.",
      assertions: [
        {
          claim: "The feature source line is pinned.",
          supports: [pin],
        },
      ],
    },
  ],
})

describe("initiative CLI", () => {
  test("pins source, creates, verifies, and promotes through a usable path", async () => {
    const item = fixture()

    expect(
      await runInitiativeCli(
        [
          "pin",
          "src/feature.ts",
          "--kind",
          "code",
          "--lines",
          "1-1",
          "--json",
        ],
        item.context,
      ),
    ).toBe(0)
    const pinned = json<{ pin: Record<string, unknown> }>(item.stdout)
    expect(pinned.pin.path).toBe("src/feature.ts")
    expect(pinned.pin.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const draft = {
      title: "Initiative command path",
      scope: {
        summary: "Use a nested initiative record, not a note.",
        intendedBehavior: "Provide pin, create, verify, scope, and promote.",
        sourcePath: "docs/scope.md",
      },
      milestones: [
        {
          title: "Command path",
          intendedBehavior: "The minimal path is executable and honest.",
          assertions: [
            {
              claim: "The feature source line is pinned.",
              supports: [pinned.pin],
            },
          ],
        },
      ],
    }
    writeFileSync(
      join(item.base, "draft.json"),
      JSON.stringify(draft, null, 2),
      "utf8",
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["create", "--draft", "draft.json", "--json"],
        item.context,
      ),
    ).toBe(0)
    const created = json<{
      initiative: {
        id: string
        path: string
        milestones: ReadonlyArray<{
          assertions: ReadonlyArray<{ id: string }>
        }>
      }
    }>(item.stdout)
    expect(created.initiative.id).toStartWith("initiative-")
    expect(created.initiative.path).toContain("/.slipmem/initiatives/")
    expect(readdirSync(item.root).filter((name) => name.endsWith(".md"))).toEqual(
      [],
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["scope", created.initiative.id, "--json"],
        item.context,
      ),
    ).toBe(0)
    const scope = json<{
      scope: { source: { path: string; contentHash: string } }
    }>(item.stdout)
    expect(scope.scope.source.path).toBe("docs/scope.md")

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["verify", created.initiative.id, "--json"],
        item.context,
      ),
    ).toBe(0)
    const verified = json<{
      report: {
        advisory: boolean
        verificationMode: string
        supported: ReadonlyArray<{ assertionId: string }>
        contradicted: ReadonlyArray<unknown>
        notEvidenced: ReadonlyArray<unknown>
      }
    }>(item.stdout)
    expect(verified.report.advisory).toBe(true)
    expect(verified.report.verificationMode).toBe("working-tree")
    expect(verified.report.supported).toHaveLength(1)
    expect(verified.report.contradicted).toHaveLength(0)
    expect(verified.report.notEvidenced).toHaveLength(0)

    const assertionId = created.initiative.milestones[0]!.assertions[0]!.id
    item.stderr.length = 0
    expect(
      await runInitiativeCli(
        [
          "promote",
          created.initiative.id,
          assertionId,
          "--json",
        ],
        item.context,
      ),
    ).toBe(1)
    const blocked = json<{
      ok: false
      error: { code: string; message: string }
    }>(item.stderr)
    expect(blocked.error.code).toBe("main-required")
    expect(blocked.error.message).toContain("trusted snapshot")

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        [
          "promote",
          created.initiative.id,
          assertionId,
          "--allow-unversioned",
          "--json",
        ],
        item.context,
      ),
    ).toBe(0)
    const promoted = json<{
      created: boolean
      promotion: { initiativeId: string; assertionId: string }
      record: { revision: number }
      projection: { status: string; reason?: string }
    }>(item.stdout)
    expect(promoted.created).toBe(true)
    expect(promoted.promotion.initiativeId).toBe(created.initiative.id)
    expect(promoted.promotion.assertionId).toBe(assertionId)
    expect(promoted.projection.status).toBe("skipped")
    expect(promoted.projection.reason).toBe("unversioned")
    expect(readdirSync(item.root).filter((name) => name.endsWith(".md"))).toEqual(
      [],
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        [
          "promote",
          created.initiative.id,
          assertionId,
          "--allow-unversioned",
          "--json",
        ],
        item.context,
      ),
    ).toBe(0)
    const retried = json<{
      created: boolean
      record: { revision: number }
    }>(item.stdout)
    expect(retried.created).toBe(false)
    expect(retried.record.revision).toBe(promoted.record.revision)

    item.stdout.length = 0
    expect(
      await runInitiativeCli(["list", "--json"], item.context),
    ).toBe(0)
    const listed = json<{
      initiatives: ReadonlyArray<{ id: string; promotionCount: number }>
    }>(item.stdout)
    expect(listed.initiatives).toHaveLength(1)
    expect(listed.initiatives[0]?.id).toBe(created.initiative.id)
    expect(listed.initiatives[0]?.promotionCount).toBe(1)
  })

  test("disclose that promotion without Git is explicit and unversioned", async () => {
    const item = fixture()
    expect(
      await runInitiativeCli(
        [
          "create",
          "--title",
          "Explicit path",
          "--scope",
          "Keep promotion explicit.",
          "--intended-behavior",
          "Never auto-promote.",
          "--json",
        ],
        item.context,
      ),
    ).toBe(0)
    const created = json<{ initiative: { id: string } }>(item.stdout)
    expect(created.initiative.id).toStartWith("initiative-")
  })

  test("text output exposes a stale projection", async () => {
    const item = fixture()
    initializeGit(item.base)

    expect(
      await runInitiativeCli(
        ["pin", "src/feature.ts", "--kind", "code", "--lines", "1-1", "--json"],
        item.context,
      ),
    ).toBe(0)
    const pinned = json<{ pin: Record<string, unknown> }>(item.stdout)
    writeFileSync(
      join(item.base, "draft.json"),
      JSON.stringify(draftWithPin(pinned.pin), null, 2),
      "utf8",
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["create", "--draft", "draft.json", "--json"],
        item.context,
      ),
    ).toBe(0)
    const created = json<{
      initiative: {
        id: string
        milestones: ReadonlyArray<{
          assertions: ReadonlyArray<{ id: string }>
        }>
      }
    }>(item.stdout)
    const assertionId = created.initiative.milestones[0]!.assertions[0]!.id

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["promote", created.initiative.id, assertionId, "--json"],
        item.context,
      ),
    ).toBe(0)
    const promoted = json<{
      promotion: { evidenceDigest: string }
      projection: { status: string }
    }>(item.stdout)
    expect(promoted.projection.status).toBe("created")

    const noteName = readdirSync(item.root).find((name) => name.endsWith(".md"))
    expect(noteName).toBeDefined()
    const notePath = join(item.root, noteName!)
    writeFileSync(
      notePath,
      readFileSync(notePath, "utf8").replaceAll(
        promoted.promotion.evidenceDigest,
        "0".repeat(64),
      ),
      "utf8",
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["project", created.initiative.id, assertionId],
        item.context,
      ),
    ).toBe(0)
    expect(item.stdout.join("")).toContain("(stale)")

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["reconcile", created.initiative.id],
        item.context,
      ),
    ).toBe(0)
    expect(item.stdout.join("")).toContain("(stale)")
  })

  test("text output reports a committed promotion with a pending projection", async () => {
    const item = fixture()
    initializeGit(item.base)

    expect(
      await runInitiativeCli(
        ["pin", "src/feature.ts", "--kind", "code", "--lines", "1-1", "--json"],
        item.context,
      ),
    ).toBe(0)
    const pinned = json<{ pin: Record<string, unknown> }>(item.stdout)
    writeFileSync(
      join(item.base, "draft.json"),
      JSON.stringify(draftWithPin(pinned.pin), null, 2),
      "utf8",
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["create", "--draft", "draft.json", "--json"],
        item.context,
      ),
    ).toBe(0)
    const created = json<{
      initiative: {
        id: string
        milestones: ReadonlyArray<{
          assertions: ReadonlyArray<{ id: string }>
        }>
      }
    }>(item.stdout)
    const assertionId = created.initiative.milestones[0]!.assertions[0]!.id

    const promotionId = `promotion-${assertionId}`
    const receipts = join(item.root, ".state", "initiative-projections")
    mkdirSync(receipts, { recursive: true })
    const createdAt = new Date(item.context.now()).toISOString()
    writeFileSync(
      join(
        receipts,
        `${createHash("sha256")
          .update(
            `${created.initiative.id}\0${assertionId}\0${promotionId}`,
          )
          .digest("hex")
          .slice(0, 32)}.json`,
      ),
      `${JSON.stringify(
        {
          schema: "slipmem.initiative-projection-receipt.v1",
          promotionId,
          initiativeId: created.initiative.id,
          assertionId,
          evidenceDigest: "a".repeat(64),
          status: "pending",
          createdAt,
          updatedAt: createdAt,
          pid: process.pid + 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["promote", created.initiative.id, assertionId],
        item.context,
      ),
    ).toBe(0)
    const output = item.stdout.join("")
    expect(output).toContain("main note projection: pending")
    expect(output).toContain("Promotion is committed")
    expect(
      readdirSync(item.root).filter((name) => name.endsWith(".md")),
    ).toEqual([])

    item.stdout.length = 0
    expect(
      await runInitiativeCli(
        ["reconcile", created.initiative.id],
        item.context,
      ),
    ).toBe(0)
    expect(item.stdout.join("")).toContain("pending")
  })

  test("missing required options fail as usage errors", async () => {
    const item = fixture()
    expect(
      await runInitiativeCli(["create", "--json"], item.context),
    ).toBe(2)
    const error = json<{ error: { kind: string; message: string } }>(
      item.stderr,
    )
    expect(error.error.kind).toBe("usage")
    expect(error.error.message).toContain("--title")
  })
})
