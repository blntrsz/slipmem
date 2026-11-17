import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface Setup {
  readonly base: string
  readonly root: string
  readonly env: Record<string, string>
}

interface SearchResult {
  readonly ok: boolean
  readonly count: number
  readonly query: string
  readonly index: { readonly mode: string }
  readonly results: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly type: string
    readonly excerpt: string
    readonly score: number
  }>
}

interface TopicsResult {
  readonly ok: boolean
  readonly count: number
  readonly topics: ReadonlyArray<{ readonly topic: string; readonly noteCount: number }>
}

interface CheckResult {
  readonly ok: boolean
  readonly report: {
    readonly ok: boolean
    readonly noteCount: number
    readonly issues: ReadonlyArray<{ readonly code: string }>
    readonly warnings: ReadonlyArray<{ readonly code: string }>
    readonly index: { readonly checked: boolean; readonly drift: number }
  }
  readonly index?: {
    readonly mode: string
    readonly rebuilt: boolean
    readonly noteCount: number
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
  return { base, root, env }
}

const run = (
  setupValue: Setup,
  args: ReadonlyArray<string>,
  stdin?: string,
) => {
  const [command, ...rest] = args
  return runCliProcess([command!, "--dir", setupValue.root, ...rest], {
    env: setupValue.env,
    ...(stdin === undefined ? {} : { stdin }),
  })
}

const create = async (
  setupValue: Setup,
  type: string,
  title: string,
  content: string,
  topic: string,
  reference?: string,
): Promise<string> => {
  const result = await run(setupValue, [
    "new",
    "--type",
    type,
    "--title",
    title,
    "--content",
    content,
    "--topic",
    topic,
    ...(reference === undefined ? [] : ["--reference", reference]),
    "--json",
  ])
  expect(result.code).toBe(0)
  return parseJson<{ note: { id: string } }>(result.stdout).note.id
}

describe("slipmem search, topics, and check", () => {
  test("searches the refreshed index with bounded filters and excerpts", async () => {
    const setupValue = await setup()
    await create(
      setupValue,
      "permanent",
      "Agent memory is bounded",
      "Every recall operation has a hard server-side limit.",
      "agent-memory",
    )
    await create(
      setupValue,
      "fleeting",
      "Loose memory idea",
      "Agents need bounded context before they can act.",
      "agent-memory",
    )
    await create(
      setupValue,
      "literature",
      "Cited recall paper",
      "Recall must cite sources and stay bounded.",
      "retrieval",
      "Paper, 2026",
    )

    const bounded = await run(setupValue, ["search", "bounded", "--json"])
    expect(bounded.code).toBe(0)
    const boundedResult = parseJson<SearchResult>(bounded.stdout)
    expect(boundedResult.count).toBe(3)
    expect(boundedResult.index.mode).toBe("fts5")
    expect(
      boundedResult.results.some((result) => result.excerpt.includes("bounded")),
    ).toBe(true)

    const permanent = await run(setupValue, [
      "search",
      "recall",
      "--type",
      "permanent",
      "--json",
    ])
    expect(parseJson<SearchResult>(permanent.stdout).count).toBe(1)

    const topic = await run(setupValue, [
      "search",
      "memory",
      "--topic",
      "agent-memory",
      "--json",
    ])
    const topicResult = parseJson<SearchResult>(topic.stdout)
    expect(topicResult.count).toBe(2)
    expect(topicResult.results.every((result) => result.type !== "literature")).toBe(
      true,
    )

    const limited = await run(setupValue, [
      "search",
      "bounded",
      "--limit",
      "1",
      "--json",
    ])
    expect(parseJson<SearchResult>(limited.stdout).count).toBe(1)

    const empty = await run(setupValue, ["search", "no-such-term", "--json"])
    expect(empty.code).toBe(0)
    expect(parseJson<SearchResult>(empty.stdout).count).toBe(0)

    const human = await run(setupValue, ["search", "bounded"])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("[permanent]")
    expect(human.stdout).toContain("3 results")

    const missingQuery = await run(setupValue, ["search", "--json"])
    expect(missingQuery.code).toBe(2)
  }, 30000)

  test("refreshes the index after a note changes outside search", async () => {
    const setupValue = await setup()
    const id = await create(
      setupValue,
      "permanent",
      "Refresh proof",
      "The original vocabulary mentions apples.",
      "index-proof",
    )

    const before = await run(setupValue, ["search", "apples", "--json"])
    expect(parseJson<SearchResult>(before.stdout).count).toBe(1)

    const editor = join(setupValue.base, "edit.ts")
    writeFileSync(
      editor,
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
const path = process.argv[2]
const text = readFileSync(path, "utf8")
writeFileSync(path, text.replace("apples", "oranges"))
`,
      { mode: 0o755 },
    )
    const edited = await runCliProcess(["edit", id, "--dir", setupValue.root, "--json"], {
      env: { ...setupValue.env, SLIPMEM_EDITOR: editor },
    })
    expect(edited.code).toBe(0)

    const after = await run(setupValue, ["search", "oranges", "--json"])
    expect(parseJson<SearchResult>(after.stdout).count).toBe(1)
    const stale = await run(setupValue, ["search", "apples", "--json"])
    expect(parseJson<SearchResult>(stale.stdout).count).toBe(0)
  }, 30000)

  test("lists derived topics with counts and a query filter", async () => {
    const setupValue = await setup()
    await create(setupValue, "permanent", "One", "Body one.", "agent-memory")
    await create(setupValue, "fleeting", "Two", "Body two.", "agent-memory")
    await create(setupValue, "literature", "Three", "Body three.", "retrieval", "Source")

    const all = await run(setupValue, ["topics", "--json"])
    expect(all.code).toBe(0)
    const topics = parseJson<TopicsResult>(all.stdout)
    expect(topics.count).toBe(2)
    expect(topics.topics).toEqual([
      { topic: "agent-memory", noteCount: 2 },
      { topic: "retrieval", noteCount: 1 },
    ])

    const filtered = await run(setupValue, ["topics", "--query", "retriev", "--json"])
    expect(parseJson<TopicsResult>(filtered.stdout).topics).toEqual([
      { topic: "retrieval", noteCount: 1 },
    ])

    const human = await run(setupValue, ["topics"])
    expect(human.stdout).toContain("agent-memory")
    expect(human.stdout).toContain("2")
  }, 30000)

  test("checks a clean root, reports errors, and rebuilds the index", async () => {
    const setupValue = await setup()
    await create(setupValue, "permanent", "Clean note", "A valid body.", "health")

    const clean = await run(setupValue, ["check", "--json"])
    expect(clean.code).toBe(0)
    const cleanResult = parseJson<CheckResult>(clean.stdout)
    expect(cleanResult.ok).toBe(true)
    expect(cleanResult.report.noteCount).toBe(1)
    expect(cleanResult.report.issues).toEqual([])
    // README and .gitignore are reported as non-note entries, not errors.
    expect(cleanResult.report.warnings.map((warning) => warning.code)).toContain(
      "unexpected-file",
    )
    expect(cleanResult.report.index.checked).toBe(false)

    const rebuilt = await run(setupValue, ["check", "--rebuild-index", "--json"])
    expect(rebuilt.code).toBe(0)
    const rebuiltResult = parseJson<CheckResult>(rebuilt.stdout)
    expect(rebuiltResult.index).toMatchObject({ rebuilt: true, noteCount: 1 })
    expect(rebuiltResult.report.index.checked).toBe(true)
    expect(rebuiltResult.report.index.drift).toBe(0)

    mkdirSync(join(setupValue.root, ".state"), { recursive: true })
    writeFileSync(
      join(setupValue.root, "20990101000000-broken.md"),
      "not frontmatter\n",
    )
    const failed = await run(setupValue, ["check", "--json"])
    expect(failed.code).toBe(1)
    const failedResult = parseJson<CheckResult>(failed.stdout)
    expect(failedResult.ok).toBe(false)
    expect(failedResult.report.issues.length).toBeGreaterThan(0)
  }, 30000)
})
