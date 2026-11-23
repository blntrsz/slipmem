import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
  const base = mkdtempSync("/tmp/opencode/slipmem-initiative-cli-")
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
