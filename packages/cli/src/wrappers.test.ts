import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { cliEntry, makeTempBase, parseJson, runCliProcess } from "./test-support.js"

const cleanup: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

/**
 * These wrappers exercise transport startup, not model providers. Strip any
 * ambient live chat, maintenance, recall, or capture configuration and use an
 * unreachable loopback chat fixture, because public MCP/web serve entrypoints
 * now require a primary model. The fixture performs no call when the disposable
 * root has no pending raw notes.
 */
const providerEnvKeys = [
  "SLIPMEM_AUTO_MEMORY",
  "SLIPMEM_AUTO_MEMORY_INTERVAL_MS",
  "SLIPMEM_AUTO_MEMORY_RUN_ON_START",
  "SLIPMEM_CHAT_PROVIDER",
  "SLIPMEM_CHAT_BASE_URL",
  "SLIPMEM_CHAT_MODEL",
  "SLIPMEM_CHAT_API_KEY",
  "SLIPMEM_MAINTENANCE_PROVIDER",
  "SLIPMEM_MAINTENANCE_BASE_URL",
  "SLIPMEM_MAINTENANCE_MODEL",
  "SLIPMEM_MAINTENANCE_API_KEY",
  "SLIPMEM_RECALL_PROVIDER",
  "SLIPMEM_RECALL_JEV_MODEL",
  "SLIPMEM_CAPTURE_PROVIDER",
  "SLIPMEM_CAPTURE_BASE_URL",
  "SLIPMEM_CAPTURE_MODEL",
  "SLIPMEM_CAPTURE_API_KEY",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const

const inertEnv = (
  extra: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const key of providerEnvKeys) {
    delete env[key]
  }
  return {
    ...env,
    SLIPMEM_CHAT_PROVIDER: "openai-compatible",
    SLIPMEM_CHAT_MODEL: "offline-wrapper-test-model",
    SLIPMEM_CHAT_BASE_URL: "http://127.0.0.1:9/v1",
    SLIPMEM_CHAT_API_KEY: "offline-wrapper-test-key",
    SLIPMEM_RECALL_PROVIDER: "off",
    ...extra,
  }
}

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
    SLIPMEM_RECALL_PROVIDER: "off",
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

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port
  probe.stop(true)
  if (port === undefined || port === 0) {
    throw new Error("Could not allocate a disposable port for the web wrapper test.")
  }
  return port
}

const childPids = (pid: number): ReadonlyArray<number> => {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()
    return raw === "" ? [] : raw.split(/\s+/).map((value) => Number(value))
  } catch {
    return []
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async <A>(
  read: () => A | undefined,
  timeoutMs = 10000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) {
      return value
    }
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for the wrapper child process.")
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
  throw new Error("Timed out waiting for the wrapper to stop its child.")
}

describe("slipmem wrappers launched from outside the repository", () => {
  test("mcp starts the real stdio server and completes a handshake", async () => {
    const setupValue = await setup()
    const server = Bun.spawn(
      [process.execPath, cliEntry, "mcp", "--dir", setupValue.root],
      {
        cwd: setupValue.base,
        env: inertEnv(setupValue.env),
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

  test("forwards SIGTERM to the wrapped child instead of orphaning it", async () => {
    const setupValue = await setup()
    const wrapper = Bun.spawn(
      [process.execPath, cliEntry, "mcp", "--dir", setupValue.root],
      {
        cwd: setupValue.base,
        env: inertEnv(setupValue.env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    )
    children.push(wrapper)

    const childPid = await waitFor(() => childPids(wrapper.pid!)[0])
    process.kill(wrapper.pid!, "SIGTERM")

    const code = await Promise.race([
      wrapper.exited,
      Bun.sleep(15000).then(() => {
        throw new Error("The wrapper did not exit after SIGTERM.")
      }),
    ])
    expect(code).toBe(143)
    await waitUntil(() => !isAlive(childPid))
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

  test("web serves the note root resolved outside the repository", async () => {
    const setupValue = await setup()
    const port = freePort()
    const server = Bun.spawn([process.execPath, cliEntry, "web"], {
      cwd: setupValue.base,
      env: inertEnv({
        ...setupValue.env,
        SLIPMEM_DIR: setupValue.root,
        HOST: "127.0.0.1",
        PORT: String(port),
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    children.push(server)

    const deadline = Date.now() + 30000
    let health: { ok?: boolean; noteRoot?: string } | undefined
    let lastError = ""

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (response.ok) {
          health = (await response.json()) as { ok?: boolean; noteRoot?: string }
          break
        }
        lastError = `HTTP ${response.status}`
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause)
      }
      await Bun.sleep(200)
    }

    if (health === undefined) {
      const output = await new Response(server.stdout).text()
      const errors = await new Response(server.stderr).text()
      throw new Error(
        `The web wrapper did not serve /api/health (${lastError}).\nstdout:\n${output}\nstderr:\n${errors}`,
      )
    }
    expect(health.ok).toBe(true)
    expect(health.noteRoot).toBe(setupValue.root)
  }, 45000)
})
