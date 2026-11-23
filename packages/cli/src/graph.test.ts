import { afterEach, describe, expect, test } from "bun:test"
import {
  initializeNoteRoot,
  makeMarkdownNoteRepository,
  type MarkdownNoteRepositoryShape,
} from "@slipmem/core"
import { Effect } from "effect"
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { CliContext } from "./context.js"
import { runCli } from "./cli.js"
import { makeTempBase, parseJson } from "./test-support.js"
import { graphCommand } from "./commands/graph.js"

const NOW = Date.parse("2026-11-22T12:00:00Z")
const ZERO_HASH = "0".repeat(64)

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

interface Harness {
  readonly root: string
  readonly repository: MarkdownNoteRepositoryShape
  readonly context: CliContext
  readonly stdout: () => string
  readonly stderr: () => string
  readonly resetOutput: () => void
}

const setup = async (): Promise<Harness> => {
  const base = makeTempBase()
  cleanup.push(base)
  const root = join(base, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({ root, now: () => NOW }),
  )

  let stdout = ""
  let stderr = ""
  const context: CliContext = {
    cwd: base,
    env: {
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
    },
    io: {
      out: (text) => {
        stdout += text
      },
      err: (text) => {
        stderr += text
      },
    },
    now: () => NOW,
    stdinIsTTY: false,
    readStdin: async () => "",
    openEditor: async () => 0,
  }

  return {
    root,
    repository,
    context,
    stdout: () => stdout,
    stderr: () => stderr,
    resetOutput: () => {
      stdout = ""
      stderr = ""
    },
  }
}

const run = (harness: Harness, args: ReadonlyArray<string>) => {
  harness.resetOutput()
  return runCli(
    [...args, "--dir", harness.root],
    harness.context,
    [graphCommand],
  )
}

interface GraphResult {
  readonly ok: boolean
  readonly root: string
  readonly noteCount: number
  readonly edgeCount: number
  readonly count: number
  readonly filters: {
    readonly direction: string | null
    readonly kind: string | null
    readonly status: string | null
    readonly includeLinks: boolean
    readonly limit: number
  }
  readonly nodes?: ReadonlyArray<{ readonly id: string; readonly managed: boolean }>
  readonly edges?: ReadonlyArray<{
    readonly from: string
    readonly to: string
    readonly kind: string
    readonly status: string
    readonly recordedTargetHash: string | null
    readonly currentTargetHash: string | null
    readonly evidence: ReadonlyArray<{ readonly id: string; readonly contentHash: string }>
    readonly disposable: boolean
  }>
  readonly note?: {
    readonly id: string
    readonly type: string
    readonly title: string
    readonly managed: boolean
  }
  readonly outgoing?: ReadonlyArray<{ readonly kind: string; readonly to: string }>
  readonly incoming?: ReadonlyArray<{ readonly kind: string; readonly from: string }>
  readonly invalidated?: ReadonlyArray<{ readonly kind: string }>
}

const graphJson = (harness: Harness): GraphResult =>
  parseJson<GraphResult>(harness.stdout())

describe("slipmem graph", () => {
  test("projects Markdown links and a focused note view without writing", async () => {
    const harness = await setup()
    const target = await Effect.runPromise(
      harness.repository.create({
        type: "permanent",
        title: "Target note",
        content: "The durable target.",
        tags: ["memory"],
      }),
    )
    const source = await Effect.runPromise(
      harness.repository.create({
        type: "permanent",
        title: "Source note",
        content: `See [[${target.id}]] for the underlying idea.`,
        tags: ["memory"],
      }),
    )

    const before = readdirSync(harness.root)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => [entry, readFileSync(join(harness.root, entry), "utf8")])

    const whole = await run(harness, ["graph", "--json"])
    expect(whole).toBe(0)
    const graph = graphJson(harness)
    expect(graph).toMatchObject({
      ok: true,
      root: harness.root,
      noteCount: 2,
      edgeCount: 1,
      count: 1,
      filters: {
        direction: null,
        kind: null,
        status: null,
        includeLinks: true,
        limit: 100,
      },
    })
    expect(graph.edges).toEqual([
      {
        from: source.id,
        to: target.id,
        kind: "link",
        status: "current",
        recordedTargetHash: null,
        currentTargetHash: target.contentHash,
        evidence: [],
        disposable: true,
      },
    ])
    expect(graph.nodes?.map((node) => node.id)).toEqual(
      [source.id, target.id].sort(),
    )

    const focused = await run(harness, ["graph", target.id, "--json"])
    expect(focused).toBe(0)
    const view = graphJson(harness)
    expect(view.note).toMatchObject({
      id: target.id,
      type: "permanent",
      title: "Target note",
    })
    expect(view.outgoing).toEqual([])
    expect(view.incoming).toEqual([
      expect.objectContaining({ from: source.id, kind: "link" }),
    ])
    expect(view.invalidated).toEqual([])

    const after = readdirSync(harness.root)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => [entry, readFileSync(join(harness.root, entry), "utf8")])
    expect(after).toEqual(before)
  })

  test("shows version-pinned relations, stale status, filters, and invalidation", async () => {
    const harness = await setup()
    const target = await Effect.runPromise(
      harness.repository.create({
        type: "permanent",
        title: "Pinned target",
        content: "The target version.",
      }),
    )
    const source = await Effect.runPromise(
      harness.repository.create({
        type: "permanent",
        title: "Generated source",
        content: `Generated summary that also links [[${target.id}]].`,
        unknown: {
          maintenance: {
            version: 2,
            generatedAt: "2026-11-22T12:00:00Z",
            stateHash: ZERO_HASH,
            sources: [{ id: target.id, contentHash: target.contentHash }],
            relations: [
              {
                kind: "supersedes",
                target: target.id,
                targetHash: target.contentHash,
                evidence: [{ id: target.id, contentHash: target.contentHash }],
              },
            ],
          },
        },
      }),
    )

    const initial = await run(harness, ["graph", "--json"])
    expect(initial).toBe(0)
    const initialGraph = graphJson(harness)
    expect(initialGraph.edgeCount).toBe(3)
    expect(initialGraph.edges?.map((edge) => edge.kind)).toEqual([
      "derived_from",
      "link",
      "supersedes",
    ])
    expect(initialGraph.edges?.every((edge) => edge.status === "current")).toBe(
      true,
    )

    await Effect.runPromise(
      harness.repository.update({
        id: target.id,
        content: "The target changed after the relation was recorded.",
      }),
    )

    const stale = await run(harness, ["graph", "--status", "stale", "--json"])
    expect(stale).toBe(0)
    const staleGraph = graphJson(harness)
    expect(staleGraph.count).toBe(2)
    expect(staleGraph.edges?.map((edge) => edge.kind)).toEqual([
      "derived_from",
      "supersedes",
    ])
    expect(staleGraph.edges?.every((edge) => edge.disposable === false)).toBe(
      true,
    )

    const kind = await run(harness, [
      "graph",
      "--kind",
      "supersedes",
      "--json",
    ])
    expect(kind).toBe(0)
    expect(graphJson(harness).count).toBe(1)

    const endpoints = await run(harness, [
      "graph",
      "--from",
      source.id,
      "--to",
      target.id,
      "--json",
    ])
    expect(endpoints).toBe(0)
    expect(graphJson(harness).count).toBe(3)
    expect(graphJson(harness).filters).toMatchObject({
      from: source.id,
      to: target.id,
    })

    const noLinks = await run(harness, ["graph", "--no-links", "--json"])
    expect(noLinks).toBe(0)
    const typedOnly = graphJson(harness)
    expect(typedOnly.count).toBe(2)
    expect(typedOnly.filters.includeLinks).toBe(false)
    expect(typedOnly.edges?.some((edge) => edge.disposable)).toBe(false)

    const focused = await run(harness, ["graph", source.id, "--json"])
    expect(focused).toBe(0)
    const view = graphJson(harness)
    expect(view.outgoing?.map((edge) => edge.kind)).toEqual([
      "derived_from",
      "link",
      "supersedes",
    ])
    expect(view.invalidated?.map((edge) => edge.kind)).toEqual([
      "derived_from",
      "supersedes",
    ])

    const limited = await run(harness, ["graph", "--limit", "1", "--json"])
    expect(limited).toBe(0)
    expect(graphJson(harness)).toMatchObject({
      count: 1,
      filters: { limit: 1 },
    })
  })

  test("rejects invalid filters and never invents a missing note", async () => {
    const harness = await setup()
    await Effect.runPromise(
      harness.repository.create({
        type: "permanent",
        title: "Only note",
        content: "A body with no links.",
      }),
    )

    const missing = await run(harness, ["graph", "missing-note", "--json"])
    expect(missing).toBe(1)
    expect(harness.stderr()).toContain("not-found")
    expect(harness.stderr()).toContain("never invents a node")

    const badKind = await run(harness, ["graph", "--kind", "cites"])
    expect(badKind).toBe(2)
    expect(harness.stderr()).toContain("--kind must be one of")

    const badStatus = await run(harness, ["graph", "--status", "broken"])
    expect(badStatus).toBe(2)
    expect(harness.stderr()).toContain("--status must be one of")

    const badDirection = await run(harness, ["graph", "--direction", "sideways"])
    expect(badDirection).toBe(2)
    expect(harness.stderr()).toContain("--direction must be")

    const directionWithoutNote = await run(harness, [
      "graph",
      "--direction",
      "incoming",
    ])
    expect(directionWithoutNote).toBe(2)
    expect(harness.stderr()).toContain("--direction requires a note ID")

    const emptyFrom = await run(harness, ["graph", "--from", ""])
    expect(emptyFrom).toBe(2)
    expect(harness.stderr()).toContain("--from requires a non-empty note ID")

    const badLimit = await run(harness, ["graph", "--limit", "0"])
    expect(badLimit).toBe(2)
    expect(harness.stderr()).toContain("--limit must be an integer")

    const tooMany = await run(harness, ["graph", "one", "two"])
    expect(tooMany).toBe(2)
    expect(harness.stderr()).toContain("at most 1")
  })
})
