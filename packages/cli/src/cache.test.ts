import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface CacheResult {
  readonly ok: boolean
  readonly root: string
  readonly path: string
  readonly existed: boolean
  readonly clearedNotes: number
  readonly noteCount: number
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

const run = (
  setupValue: { root: string; env: Record<string, string> },
  args: ReadonlyArray<string>,
) =>
  runCliProcess([args[0]!, "--dir", setupValue.root, ...args.slice(1)], {
    env: setupValue.env,
  })

describe("slipmem cache clear", () => {
  test("clears only the derived index and leaves notes readable", async () => {
    const setupValue = await setup()
    const created = await run(setupValue, [
      "new",
      "--type",
      "permanent",
      "--title",
      "Bounded recall",
      "--content",
      "Search indexes are disposable.",
      "--topic",
      "agent-memory",
      "--json",
    ])
    expect(created.code).toBe(0)
    const noteId = parseJson<{ note: { id: string } }>(created.stdout).note.id
    const notePath = join(setupValue.root, `${noteId}.md`)

    const searched = await run(setupValue, ["search", "disposable", "--json"])
    expect(searched.code).toBe(0)
    expect(parseJson<{ count: number }>(searched.stdout).count).toBe(1)

    const cleared = await run(setupValue, ["cache", "clear", "--json"])
    expect(cleared.code).toBe(0)
    const result = parseJson<CacheResult>(cleared.stdout)
    expect(result).toMatchObject({
      ok: true,
      existed: true,
      clearedNotes: 1,
      noteCount: 0,
    })
    expect(result.path).toContain("index.sqlite")
    expect(existsSync(result.path)).toBe(true)
    expect(existsSync(notePath)).toBe(true)

    const shown = await run(setupValue, ["show", noteId, "--json"])
    expect(shown.code).toBe(0)

    const rebuilt = await run(setupValue, ["search", "disposable", "--json"])
    expect(rebuilt.code).toBe(0)
    expect(parseJson<{ count: number }>(rebuilt.stdout).count).toBe(1)
  }, 30000)

  test("is safe before an index exists and reports a human summary", async () => {
    const setupValue = await setup()

    const cleared = await run(setupValue, ["cache", "clear", "--json"])
    expect(cleared.code).toBe(0)
    expect(parseJson<CacheResult>(cleared.stdout)).toMatchObject({
      existed: false,
      clearedNotes: 0,
      noteCount: 0,
    })

    const human = await run(setupValue, ["cache", "clear"])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("note files were not changed")

    const unknown = await run(setupValue, ["cache", "prune", "--json"])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain("cache supports only 'clear'")
  }, 30000)
})
