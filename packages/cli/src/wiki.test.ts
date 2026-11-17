import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
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
  })

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
  })

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
  })

  test("reports synthesized mode as unavailable instead of downgrading it", async () => {
    const setupValue = await setup()
    await create(setupValue, "permanent", "One", "Body one.", "agent-memory")

    const synthesized = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--mode",
      "synthesized",
      "--json",
    ])
    expect(synthesized.code).toBe(2)
    const envelope = parseJson<{ error: { kind: string; code: string } }>(
      synthesized.stderr,
    )
    expect(envelope.error).toMatchObject({
      kind: "unavailable",
      code: "synthesis-unavailable",
    })

    const model = await run(setupValue, [
      "wiki",
      "agent-memory",
      "--model",
      "local-model",
      "--json",
    ])
    expect(model.code).toBe(2)
  }, 30000)
})
