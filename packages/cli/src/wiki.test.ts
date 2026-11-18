import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface WikiResult {
  readonly ok: boolean
  readonly out?: string
  readonly page: {
    readonly topic: string
    readonly mode: string
    readonly noteCount: number
    readonly sources: ReadonlyArray<{
      readonly id: string
      readonly path: string
      readonly type: string
      readonly title: string
    }>
    readonly sections: ReadonlyArray<{
      readonly heading: string
      readonly markdown: string
      readonly citations: ReadonlyArray<{
        readonly noteId: string
        readonly path: string
        readonly excerpt?: string
      }>
    }>
    readonly markdown: string
  }
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const setup = async (): Promise<{
  base: string
  root: string
  env: Record<string, string>
}> => {
  const base = makeTempBase()
  cleanup.push(base)
  const root = join(base, ".slipmem")
  const env = {
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_STATE_HOME: join(base, "state"),
    // The test fixtures are not reviewable agents and CI may not have a usable
    // bubblewrap sandbox. Exercise the documented unsafe opt-in explicitly.
    SLIPMEM_WIKI_AGENT_UNSAFE: "1",
  }
  const init = await runCliProcess(["init", "--dir", root, "--json"], { env })
  expect(init.code).toBe(0)
  return { base, root, env }
}

const create = async (
  setupValue: { root: string; env: Record<string, string> },
  type: string,
  title: string,
  content: string,
  topic: string,
  reference?: string,
): Promise<string> => {
  const result = await runCliProcess(
    [
      "new",
      "--dir",
      setupValue.root,
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
    ],
    { env: setupValue.env },
  )
  expect(result.code).toBe(0)
  return parseJson<{ note: { id: string } }>(result.stdout).note.id
}

const run = (
  setupValue: { root: string; env: Record<string, string> },
  args: ReadonlyArray<string>,
) =>
  runCliProcess([args[0]!, "--dir", setupValue.root, ...args.slice(1)], {
    env: setupValue.env,
  })

describe("slipmem wiki (extractive)", () => {
  test("builds a cited page from matching permanent and literature notes", async () => {
    const setupValue = await setup()
    const bounded = await create(
      setupValue,
      "permanent",
      "Bounded recall",
      "Every list and search has a hard limit.",
      "agent-memory",
    )
    const citation = await create(
      setupValue,
      "literature",
      "Citation rules",
      "Recall must cite its sources.",
      "agent-memory",
      "Paper, 2026",
    )
    const fleeting = await create(
      setupValue,
      "fleeting",
      "Loose memory thought",
      "Unbounded agent memory idea.",
      "agent-memory",
    )
    await create(
      setupValue,
      "permanent",
      "Cooking notes",
      "Bread needs time.",
      "cooking",
    )

    const result = await run(setupValue, ["wiki", "agent memory", "--json"])
    expect(result.code).toBe(0)
    const wiki = parseJson<WikiResult>(result.stdout)
    expect(wiki.page).toMatchObject({
      topic: "agent-memory",
      mode: "extractive",
      noteCount: 2,
    })
    expect(wiki.page.sources.map((source) => source.id).sort()).toEqual(
      [bounded, citation].sort(),
    )
    expect(wiki.page.sources.some((source) => source.id === fleeting)).toBe(false)
    expect(wiki.page.sections).toHaveLength(2)
    for (const section of wiki.page.sections) {
      expect(section.citations).toHaveLength(1)
      const excerpt = section.citations[0]!.excerpt
      expect(excerpt).toBeDefined()
      expect(section.markdown).toContain(excerpt!)
    }
    expect(wiki.page.markdown).toContain("# Topic: agent-memory")
    expect(wiki.page.markdown).toContain(`[[${bounded}]]`)
    expect(wiki.page.markdown).toContain(`[[${citation}]]`)
    expect(wiki.page.markdown).toContain("## Sources")
    expect(wiki.page.markdown).toContain("Recall must cite its sources.")
  }, 30000)

  test("honors include-fleeting, limits, and empty topics without inventing text", async () => {
    const setupValue = await setup()
    await create(setupValue, "permanent", "One", "Body one.", "agent-memory")
    await create(setupValue, "permanent", "Two", "Body two.", "agent-memory")
    await create(setupValue, "fleeting", "Three", "Body three.", "agent-memory")

    const included = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--include-fleeting",
      "--json",
    ])
    expect(parseJson<WikiResult>(included.stdout).page.noteCount).toBe(3)

    const limited = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--limit",
      "1",
      "--json",
    ])
    expect(parseJson<WikiResult>(limited.stdout).page.noteCount).toBe(1)

    const empty = await run(setupValue, ["wiki", "no-such-topic", "--json"])
    expect(empty.code).toBe(0)
    const emptyWiki = parseJson<WikiResult>(empty.stdout)
    expect(emptyWiki.page.noteCount).toBe(0)
    expect(emptyWiki.page.sections).toEqual([])
    expect(emptyWiki.page.markdown).toContain("No notes matched this topic")
  }, 30000)

  test("writes only an explicit --out outside the note root", async () => {
    const setupValue = await setup()
    await create(
      setupValue,
      "permanent",
      "Bounded recall",
      "Every search is bounded.",
      "agent-memory",
    )

    const outPath = join(setupValue.base, "topic.md")
    const written = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--out",
      outPath,
      "--json",
    ])
    expect(written.code).toBe(0)
    expect(parseJson<WikiResult>(written.stdout).out).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)

    const inside = join(setupValue.root, "topic.md")
    const refused = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--out",
      inside,
      "--json",
    ])
    expect(refused.code).toBe(2)
    expect(existsSync(inside)).toBe(false)
  }, 30000)

  test("rejects --out parents that do not exist or resolve into the note root", async () => {
    const setupValue = await setup()
    await create(
      setupValue,
      "permanent",
      "Bounded recall",
      "Every search is bounded.",
      "agent-memory",
    )

    const missingParent = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--out",
      join(setupValue.base, "missing", "topic.md"),
      "--json",
    ])
    expect(missingParent.code).toBe(2)
    expect(missingParent.stderr).toContain("--out directory does not exist")

    const linkedParent = join(setupValue.base, "linked")
    symlinkSync(setupValue.root, linkedParent, "dir")
    const throughLink = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--out",
      join(linkedParent, "topic.md"),
      "--json",
    ])
    expect(throughLink.code).toBe(2)
    expect(throughLink.stderr).toContain("--out must point outside the note root")
    expect(existsSync(join(setupValue.root, "topic.md"))).toBe(false)
  }, 30000)
})

const writeAgent = (base: string): string => {
  const path = join(base, "synthesis-agent.ts")
  writeFileSync(
    path,
    [
      'const input = await Bun.stdin.text()',
      'const payload = JSON.parse(input) as { untrustedNotes: Array<{ id: string; body: string }> }',
      'if (!Bun.argv.includes("--fixture-flag")) {',
      '  console.error("missing --fixture-flag in argv")',
      '  process.exit(3)',
      '}',
      'const note = payload.untrustedNotes[0]!',
      'const quote = note.body.trim()',
      'console.log(JSON.stringify({ sentences: [{ text: quote, noteId: note.id, quote }] }))',
    ].join("\n"),
  )
  return path
}

describe("slipmem wiki (synthesized)", () => {
  test("runs a configured local agent through argv without a shell", async () => {
    const setupValue = await setup()
    const body = "Bounded recall needs a hard limit for every search."
    const noteId = await create(
      setupValue,
      "permanent",
      "Bounded recall",
      body,
      "agent-memory",
    )
    const agent = writeAgent(setupValue.base)

    const result = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--mode",
      "synthesized",
      "--agent",
      `${process.execPath} ${agent}`,
      "--agent-arg=--fixture-flag",
      "--json",
    ])
    expect(result.code).toBe(0)
    const wiki = parseJson<WikiResult>(result.stdout)
    expect(wiki.page).toMatchObject({
      topic: "agent-memory",
      mode: "synthesized",
      noteCount: 1,
    })
    expect(wiki.page.sections[0]!.markdown).toContain(body)
    expect(wiki.page.sections[0]!.markdown).toContain(`[[${noteId}]]`)
    expect(wiki.page.markdown).toContain(`[[${noteId}]]`)
  }, 30000)

  test("honors SLIPMEM_WIKI_SYNTHESIS=agent and explicit extractive fallback", async () => {
    const setupValue = await setup()
    await create(
      setupValue,
      "permanent",
      "Bounded recall",
      "Bounded recall needs a hard limit for every search.",
      "agent-memory",
    )
    const agent = writeAgent(setupValue.base)
    const agentEnv = {
      ...setupValue.env,
      SLIPMEM_WIKI_SYNTHESIS: "agent",
      SLIPMEM_WIKI_AGENT: process.execPath,
      SLIPMEM_WIKI_AGENT_ARGS: JSON.stringify([agent, "--fixture-flag"]),
    }

    const fromEnv = await runCliProcess(
      ["wiki", "agent-memory", "--dir", setupValue.root, "--json"],
      { env: agentEnv },
    )
    expect(fromEnv.code).toBe(0)
    expect(parseJson<WikiResult>(fromEnv.stdout).page.mode).toBe("synthesized")

    const extractive = await runCliProcess(
      [
        "wiki",
        "agent-memory",
        "--dir",
        setupValue.root,
        "--mode",
        "extractive",
        "--json",
      ],
      { env: agentEnv },
    )
    expect(extractive.code).toBe(0)
    expect(parseJson<WikiResult>(extractive.stdout).page.mode).toBe("extractive")
  }, 30000)

  test("fails closed with actionable errors for missing or unsupported synthesizers", async () => {
    const setupValue = await setup()
    await create(
      setupValue,
      "permanent",
      "Bounded recall",
      "Bounded recall needs a hard limit for every search.",
      "agent-memory",
    )

    const unconfigured = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--mode",
      "synthesized",
      "--json",
    ])
    expect(unconfigured.code).toBe(1)
    const unconfiguredError = parseJson<{
      error: { kind: string; code: string; message: string }
    }>(unconfigured.stderr)
    expect(unconfiguredError.error.code).toBe("synthesis-config")
    expect(unconfiguredError.error.message).toContain("SLIPMEM_WIKI_AGENT")

    const model = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--model",
      "local-model",
      "--json",
    ])
    expect(model.code).toBe(1)
    const modelError = parseJson<{
      error: { kind: string; code: string; message: string }
    }>(model.stderr)
    expect(modelError.error.code).toBe("synthesis-adapter-unsupported")
    expect(modelError.error.message).toContain("no configured adapter")

    const both = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--model",
      "local-model",
      "--agent",
      "true",
      "--json",
    ])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain("mutually exclusive")

    const contradictory = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--mode",
      "extractive",
      "--agent",
      "true",
      "--json",
    ])
    expect(contradictory.code).toBe(2)
    expect(contradictory.stderr).toContain("cannot be combined")
  }, 30000)
})
