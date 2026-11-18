import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface NoteEnvelope {
  readonly note: { readonly id: string; readonly type: string }
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

describe("CLI acceptance workflow", () => {
  test("runs the local loop offline through the root script", async () => {
    const base = makeTempBase()
    cleanup.push(base)
    const root = join(base, ".slipmem")
    const env = {
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
    }
    const run = async (args: ReadonlyArray<string>) => {
      const [command, ...rest] = args
      return runCliProcess([command!, "--dir", root, ...rest], {
        env,
        rootScript: true,
      })
    }

    const init = await run(["init", "--json"])
    expect(init.code).toBe(0)

    const fleeting = await run([
      "new",
      "--type",
      "fleeting",
      "--title",
      "Inbox capture",
      "--content",
      "A quick thought about bounded recall.",
      "--tag",
      "agent-memory",
      "--json",
    ])
    expect(fleeting.code).toBe(0)

    const permanent = await run([
      "new",
      "--type",
      "permanent",
      "--title",
      "Bounded recall matters",
      "--content",
      "Every list and search has a hard limit.",
      "--tag",
      "agent-memory",
      "--json",
    ])
    expect(permanent.code).toBe(0)
    const permanentId = parseJson<NoteEnvelope>(permanent.stdout).note.id

    const literature = await run([
      "new",
      "--type",
      "literature",
      "--title",
      "Cited recall paper",
      "--content",
      "Recall must cite its sources.",
      "--reference",
      "Paper, 2026",
      "--tag",
      "retrieval",
      "--json",
    ])
    expect(literature.code).toBe(0)

    const list = await run(["list", "--json"])
    expect(parseJson<{ count: number }>(list.stdout).count).toBe(3)

    const search = await run(["search", "recall", "--json"])
    expect(search.code).toBe(0)
    expect(parseJson<{ count: number }>(search.stdout).count).toBeGreaterThan(0)

    const show = await run(["show", permanentId, "--json"])
    expect(show.code).toBe(0)

    const tags = await run(["tags", "--json"])
    expect(tags.code).toBe(0)
    expect(parseJson<{ count: number }>(tags.stdout).count).toBe(2)

    const wiki = await run(["wiki", "agent-memory", "--json"])
    expect(wiki.code).toBe(0)
    expect(parseJson<{ page: { noteCount: number } }>(wiki.stdout).page.noteCount).toBe(
      1,
    )

    const review = await run(["review", "--json"])
    expect(review.code).toBe(0)
    expect(parseJson<{ pending: number }>(review.stdout).pending).toBe(0)

    const check = await run(["check", "--rebuild-index", "--json"])
    expect(check.code).toBe(0)

    const help = await runCliProcess(["--help"], { env, rootScript: true })
    expect(help.code).toBe(0)
    for (const command of [
      "init",
      "new",
      "list",
      "show",
      "edit",
      "delete",
      "search",
      "tags",
      "check",
      "wiki",
      "review",
      "approve",
      "reject",
      "migrate",
      "mcp",
      "web",
    ]) {
      expect(help.stdout).toContain(command)
    }
  }, 30000)
})
