import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { cliEntry, makeTempBase, parseJson, runCliProcess } from "./test-support.js"

const cleanup: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop()!
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
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

const readLine = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 10000,
): Promise<string> =>
  Promise.race([
    (async () => {
      let buffer = ""
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          throw new Error("MCP stdout closed before a complete line arrived")
        }
        buffer += decoder.decode(value, { stream: true })
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          return buffer.slice(0, newline)
        }
      }
    })(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("Timed out waiting for an MCP response")
    }),
  ])

describe("slipmem wrappers launched from outside the repository", () => {
  test("mcp starts the real stdio server and completes a handshake", async () => {
    const setupValue = await setup()
    const server = Bun.spawn(
      [process.execPath, cliEntry, "mcp", "--dir", setupValue.root],
      {
        cwd: setupValue.base,
        env: { ...process.env, ...setupValue.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    )
    children.push(server)

    const reader = server.stdout!.getReader()
    server.stdin!.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "slipmem-wrapper-test", version: "0.0.0" },
        },
      })}\n`,
    )
    server.stdin!.flush()

    const handshake = parseJson<{
      result?: { serverInfo?: { name?: string } }
    }>(await readLine(reader))
    expect(handshake.result?.serverInfo?.name).toBe("slipmem")
  }, 30000)

  test("web starts the real Vite entry point with argv forwarding", async () => {
    const setupValue = await setup()
    const result = await runCliProcess(
      ["web", "--", "--version"],
      {
        cwd: setupValue.base,
        env: { ...setupValue.env, SLIPMEM_DIR: setupValue.root },
      },
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("vite/")
    expect(result.stderr).not.toContain("packages/packages")
  }, 30000)
})
