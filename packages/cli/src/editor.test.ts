import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { CliContext } from "./context.js"
import { editorShellScript, openProcessEditor } from "./context.js"
import { withTempDraft } from "./editor.js"
import { usageError } from "./errors.js"
import {
  cliEntry,
  makeTempBase,
  parseJson,
  runCliProcess,
} from "./test-support.js"

const drafts: string[] = []
const bases: string[] = []
const editorProcesses: number[] = []
const cliProcesses: number[] = []

afterEach(() => {
  for (const pid of cliProcesses.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The CLI already exited.
    }
  }
  for (const pid of editorProcesses.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The editor already exited.
    }
  }
  while (drafts.length > 0) {
    rmSync(drafts.pop()!, { recursive: true, force: true })
  }
  while (bases.length > 0) {
    rmSync(bases.pop()!, { recursive: true, force: true })
  }
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 10000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for a process or file state.")
}

interface EditorState {
  readonly pid: number
  readonly draft: string
}

const waitForEditorState = async (path: string): Promise<EditorState> => {
  let state: EditorState | undefined
  await waitUntil(() => {
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as EditorState
      return true
    } catch {
      return false
    }
  })
  return state!
}

const exitWithin = async (
  cli: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> =>
  Promise.race([
    cli.exited,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`The CLI did not exit within ${timeoutMs}ms.`)
    }),
  ])

const contextWithEditor = (
  openEditor: (path: string, signal?: AbortSignal) => Promise<number>,
): CliContext => ({
  cwd: "/tmp/opencode",
  env: {},
  io: { out: () => {}, err: () => {} },
  now: Date.now,
  stdinIsTTY: true,
  readStdin: async () => "",
  openEditor,
})

const track = (path: string): void => {
  drafts.push(dirname(path))
}

describe("withTempDraft", () => {
  test("removes the draft directory after a typed run failure", async () => {
    let draftDirectory: string | undefined
    const exit = await Effect.runPromiseExit(
      withTempDraft(
        "note.md",
        "body",
        contextWithEditor(async (path) => {
          draftDirectory = dirname(path)
          track(path)
          return 0
        }),
        () => Effect.fail(usageError("invalid draft")),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(draftDirectory).toBeDefined()
    expect(existsSync(draftDirectory!)).toBe(false)
  })

  test("removes the draft directory after the editor exits nonzero", async () => {
    let draftDirectory: string | undefined
    const exit = await Effect.runPromiseExit(
      withTempDraft(
        "note.md",
        "body",
        contextWithEditor(async (path) => {
          draftDirectory = dirname(path)
          track(path)
          return 7
        }),
        () => Effect.succeed("unreachable"),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(draftDirectory).toBeDefined()
    expect(existsSync(draftDirectory!)).toBe(false)
  })

  test("passes an abort signal and cleans up on interruption", async () => {
    let draftDirectory: string | undefined
    let receivedSignal: AbortSignal | undefined
    let editorStarted = false
    const controller = new AbortController()
    const context = contextWithEditor((path, signal) => {
      draftDirectory = dirname(path)
      track(path)
      receivedSignal = signal
      editorStarted = true
      return new Promise<number>((resolve) => {
        if (signal?.aborted === true) {
          resolve(1)
          return
        }
        signal?.addEventListener("abort", () => resolve(1), { once: true })
      })
    })

    const running = Effect.runPromise(
      withTempDraft("note.md", "body", context, () => Effect.never),
      { signal: controller.signal },
    )

    while (!editorStarted) {
      await Bun.sleep(1)
    }
    controller.abort()
    await running.catch(() => undefined)

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(draftDirectory).toBeDefined()
    expect(existsSync(draftDirectory!)).toBe(false)
  })
})

describe("openProcessEditor", () => {
  test("terminates the editor itself when the abort signal fires", async () => {
    const base = makeTempBase()
    bases.push(base)
    const marker = join(base, "marker")
    const pidFile = join(base, "editor.pid")
    const script = join(base, "editor.ts")
    writeFileSync(
      script,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, process.argv[2] ?? "")
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1000)
`,
      { encoding: "utf8", mode: 0o755 },
    )

    const controller = new AbortController()
    const running = openProcessEditor(
      join(base, "note.md"),
      { SHELL: "/bin/sh", SLIPMEM_EDITOR: script },
      controller.signal,
    )

    while (!existsSync(marker)) {
      await Bun.sleep(10)
    }
    const editorPid = Number(readFileSync(pidFile, "utf8"))
    editorProcesses.push(editorPid)

    controller.abort()
    await running

    let alive = true
    try {
      process.kill(editorPid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})

describe("editorShellScript", () => {
  test("execs simple commands and leading assignments", () => {
    expect(editorShellScript("vim -f")).toBe(`exec vim -f "$1"`)
    expect(editorShellScript("code --wait")).toBe(`exec code --wait "$1"`)
    expect(editorShellScript("VIMINIT='set spell' vim")).toBe(
      `exec env VIMINIT='set spell' vim "$1"`,
    )
  })

  test("leaves compound snippets and expansions in the shell", () => {
    expect(editorShellScript("vim; echo done")).toBe(`vim; echo done "$1"`)
    expect(editorShellScript("$HOME/bin/vim")).toBe(`$HOME/bin/vim "$1"`)
  })
})

describe("slipmem edit through the production entrypoint", () => {
  test("escalates an editor that ignores SIGTERM and removes the draft", async () => {
    const base = makeTempBase()
    bases.push(base)
    const root = join(base, "root", ".slipmem")
    const isolated = { SLIPMEM_DIR: "" }

    const init = await runCliProcess(["init", "--dir", root], {
      env: isolated,
    })
    expect(init.code).toBe(0)

    const created = await runCliProcess(
      [
        "new",
        "--type",
        "fleeting",
        "--title",
        "signal regression",
        "--content",
        "original body",
        "--dir",
        root,
        "--json",
      ],
      { env: isolated },
    )
    expect(created.code).toBe(0)
    const id = parseJson<{ note: { id: string } }>(created.stdout).note.id

    const stateFile = join(base, "editor-state.json")
    const termFile = join(base, "editor-got-term")
    const script = join(base, "editor.ts")
    writeFileSync(
      script,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs"
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(termFile)}, "ignored")
})
writeFileSync(
  ${JSON.stringify(stateFile)},
  JSON.stringify({ pid: process.pid, draft: process.argv[2] ?? "" }),
)
setInterval(() => {}, 1000)
`,
      { encoding: "utf8", mode: 0o755 },
    )

    const cli = Bun.spawn(
      [process.execPath, cliEntry, "edit", id, "--dir", root],
      {
        cwd: base,
        env: { ...process.env, ...isolated, SLIPMEM_EDITOR: script },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    )
    cliProcesses.push(cli.pid)

    const state = await waitForEditorState(stateFile)
    editorProcesses.push(state.pid)

    process.kill(cli.pid, "SIGTERM")
    expect(await exitWithin(cli, 15000)).toBe(143)
    await waitUntil(() => !isAlive(state.pid), 15000)

    expect(existsSync(termFile)).toBe(true)
    expect(dirname(state.draft)).toContain("slipmem-draft-")
    expect(existsSync(dirname(state.draft))).toBe(false)
  }, 30000)
})
