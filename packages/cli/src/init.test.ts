import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { makeTempBase, parseJson, runCliProcess } from "./test-support.js"

interface InitResult {
  readonly ok: boolean
  readonly root: string
  readonly created: boolean
  readonly stateDir: string
  readonly readmePath: string
}

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true })
  }
})

const tempRoot = (): string => {
  const base = makeTempBase()
  cleanup.push(base)
  return join(base, ".slipmem")
}

describe("slipmem init", () => {
  test("creates a flat repository through the root script and is idempotent", async () => {
    const root = tempRoot()

    const first = await runCliProcess(["init", "--dir", root, "--json"], {
      rootScript: true,
    })
    expect(first.code).toBe(0)
    const created = parseJson<InitResult>(first.stdout)
    expect(created).toMatchObject({ ok: true, root, created: true })

    expect(existsSync(join(root, "README.md"))).toBe(true)
    expect(existsSync(join(root, ".state"))).toBe(true)
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".state/\n")
    // A repository is flat: no type folders are created at initialization.
    expect(readdirSync(root).sort()).toEqual([".gitignore", ".state", "README.md"])

    const second = await runCliProcess(["init", "--dir", root, "--json"])
    expect(second.code).toBe(0)
    expect(parseJson<InitResult>(second.stdout).created).toBe(false)
  }, 30000)

  test("prints human help and command help without touching a repository", async () => {
    const help = await runCliProcess(["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("Usage: slipmem <command>")
    expect(help.stdout).toContain("init")

    const commandHelp = await runCliProcess(["help", "init"])
    expect(commandHelp.code).toBe(0)
    expect(commandHelp.stdout).toContain("slipmem init")
    expect(commandHelp.stdout).toContain("--dir")

    const noCommand = await runCliProcess([])
    expect(noCommand.code).toBe(0)
    expect(noCommand.stdout).toContain("Commands:")
  }, 30000)

  test("reports usage errors with status 2 and JSON on request", async () => {
    const unknown = await runCliProcess(["init", "--wat", "--json"])
    expect(unknown.code).toBe(2)
    const envelope = parseJson<{ ok: false; error: { kind: string; code: string } }>(
      unknown.stderr,
    )
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toMatchObject({ kind: "usage", code: "usage" })

    const unknownCommand = await runCliProcess(["frobnicate", "--json"])
    expect(unknownCommand.code).toBe(2)
    expect(
      parseJson<{ error: { kind: string; message: string } }>(unknownCommand.stderr)
        .error.kind,
    ).toBe("usage")
  }, 30000)
})
