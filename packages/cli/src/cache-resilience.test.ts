import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface Setup {
  readonly base: string
  readonly root: string
  readonly env: Record<string, string>
  readonly noteId: string
}

interface SearchResult {
  readonly count: number
  readonly index: { readonly path: string; readonly mode: string }
}

interface CacheResult {
  readonly ok: boolean
  readonly path: string
  readonly existed: boolean
  readonly repaired: boolean
  readonly clearedNotes: number
  readonly noteCount: number
}

interface CheckResult {
  readonly ok: boolean
  readonly report: {
    readonly ok: boolean
    readonly index: { readonly checked: boolean; readonly drift: number }
  }
  readonly index?: {
    readonly mode: string
    readonly path: string
    readonly noteCount: number
    readonly rebuilt: boolean
    readonly repaired?: boolean
    readonly warning?: string
  }
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const run = (setup: Setup, args: ReadonlyArray<string>) =>
  runCliProcess([args[0]!, "--dir", setup.root, ...args.slice(1)], {
    env: setup.env,
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

  const created = await runCliProcess(
    [
      "new",
      "--dir",
      root,
      "--type",
      "permanent",
      "--title",
      "Resilient cache",
      "--content",
      "The index is disposable and repairable.",
      "--json",
    ],
    { env },
  )
  expect(created.code).toBe(0)
  const noteId = parseJson<{ note: { id: string } }>(created.stdout).note.id
  return { base, root, env, noteId }
}

const corruptIndex = async (setupValue: Setup): Promise<string> => {
  const searched = await run(setupValue, ["search", "disposable", "--json"])
  expect(searched.code).toBe(0)
  const path = parseJson<SearchResult>(searched.stdout).index.path
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "this is not a sqlite database")
  return path
}

describe("corrupt index recovery", () => {
  test("search repairs a corrupt index before reading it", async () => {
    const setupValue = await setup()
    await corruptIndex(setupValue)

    const searched = await run(setupValue, ["search", "disposable", "--json"])
    expect(searched.code).toBe(0)
    expect(parseJson<SearchResult>(searched.stdout).count).toBe(1)
  }, 30000)

  test("cache clear repairs a corrupt index without opening it first", async () => {
    const setupValue = await setup()
    const indexPath = await corruptIndex(setupValue)

    const cleared = await run(setupValue, ["cache", "clear", "--json"])
    expect(cleared.code).toBe(0)
    expect(parseJson<CacheResult>(cleared.stdout)).toMatchObject({
      ok: true,
      path: indexPath,
      existed: true,
      repaired: true,
      clearedNotes: 0,
      noteCount: 0,
    })

    const shown = await run(setupValue, ["show", setupValue.noteId, "--json"])
    expect(shown.code).toBe(0)

    const searched = await run(setupValue, ["search", "disposable", "--json"])
    expect(searched.code).toBe(0)
    expect(parseJson<SearchResult>(searched.stdout).count).toBe(1)
  }, 30000)

  test("check --rebuild-index repairs a corrupt index and reports no drift", async () => {
    const setupValue = await setup()
    await corruptIndex(setupValue)

    const checked = await run(setupValue, [
      "check",
      "--rebuild-index",
      "--json",
    ])
    expect(checked.code).toBe(0)
    const result = parseJson<CheckResult>(checked.stdout)
    expect(result.report.ok).toBe(true)
    expect(result.report.index).toEqual({ checked: true, drift: 0 })
    expect(result.index).toMatchObject({
      rebuilt: true,
      repaired: true,
      noteCount: 1,
    })
    expect(checked.stderr).not.toContain("not a database")
  }, 30000)

  test("plain check reports an unreadable index without failing notes", async () => {
    const setupValue = await setup()
    await corruptIndex(setupValue)

    const checked = await run(setupValue, ["check", "--json"])
    expect(checked.code).toBe(0)
    const result = parseJson<CheckResult>(checked.stdout)
    expect(result.report.ok).toBe(true)
    expect(result.index?.warning).toContain("check --rebuild-index")
    expect(checked.stderr).not.toContain("not a database")
  }, 30000)
})
