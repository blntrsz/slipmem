import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { initializeNoteRoot, makeMarkdownNoteRepository } from "@slipmem/core"
import { Effect } from "effect"

const repositoryRoot = resolve(import.meta.dir, "../../..")

/**
 * Serving requires a primary chat model. These tests cover transport startup
 * and tool calls, not provider lifecycle, so use an explicit unreachable
 * loopback fixture and never inherit a host operator's live chat, maintenance,
 * recall, or capture configuration. A model is still configured here; this is
 * the supported offline fixture shape for MCP serve entrypoints.
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

const inertServerEnv = (
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
    SLIPMEM_CHAT_MODEL: "offline-mcp-main-test-model",
    SLIPMEM_CHAT_BASE_URL: "http://127.0.0.1:9/v1",
    SLIPMEM_CHAT_API_KEY: "offline-mcp-main-test-key",
    SLIPMEM_RECALL_PROVIDER: "off",
    ...extra,
  }
}

const readLine = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 15000,
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

interface WritableInput {
  readonly stdin: {
    write(data: string): unknown
    flush(): unknown
  } | null
}

const send = (server: WritableInput, message: unknown) => {
  server.stdin?.write(`${JSON.stringify(message)}\n`)
  server.stdin?.flush()
}

const initialize = (server: WritableInput) =>
  send(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "slipmem-test", version: "0.0.0" },
    },
  })

const start = (root: string, cacheRoot: string) =>
  Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env: inertServerEnv({
      SLIPMEM_DIR: root,
      XDG_CACHE_HOME: cacheRoot,
      XDG_STATE_HOME: cacheRoot,
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

test("stdio startup without a note root fails on stderr and leaves stdout empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env: inertServerEnv({
      SLIPMEM_DIR: join(directory, "missing"),
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(server.stdout).text()
  const stderr = new Response(server.stderr).text()

  try {
    const [exitCode, output, errors] = await Promise.all([
      server.exited,
      stdout,
      stderr,
    ])
    expect(exitCode).not.toBe(0)
    expect(output).toBe("")
    expect(errors).toContain("does not exist")
  } finally {
    server.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("serving without a primary chat model fails instead of running model-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  const env = inertServerEnv({
    SLIPMEM_DIR: root,
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "cache"),
  })
  delete env.SLIPMEM_CHAT_PROVIDER
  delete env.SLIPMEM_CHAT_BASE_URL
  delete env.SLIPMEM_CHAT_MODEL
  delete env.SLIPMEM_CHAT_API_KEY
  const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(server.stdout).text()
  const stderr = new Response(server.stderr).text()

  try {
    const [exitCode, output, errors] = await Promise.all([
      server.exited,
      stdout,
      stderr,
    ])
    expect(exitCode).not.toBe(0)
    expect(output).toBe("")
    expect(errors).toContain("serving requires a primary chat model")
  } finally {
    server.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("stdio server initializes, lists bounded tools, and exits cleanly on SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const root = join(directory, ".slipmem")
  let server: ReturnType<typeof start> | undefined

  try {
    await Effect.runPromise(initializeNoteRoot(root))
    server = start(root, join(directory, "cache"))

    const reader = server.stdout!.getReader()
    initialize(server)
    const handshake = JSON.parse(await readLine(reader)) as {
      readonly result?: {
        readonly serverInfo?: { readonly name?: string }
        readonly instructions?: string
      }
    }
    expect(handshake.result?.serverInfo?.name).toBe("slipmem")
    expect(handshake.result?.instructions).toContain("list_tags")
    expect(handshake.result?.instructions).toContain("search_notes")
    expect(handshake.result?.instructions).toContain("build_tag_wiki")

    send(server, { jsonrpc: "2.0", method: "notifications/initialized" })
    send(server, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const tools = JSON.parse(await readLine(reader)) as {
      readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> }
    }
    expect(tools.result?.tools?.map((tool) => tool.name)).toContain(
      "search_notes",
    )

    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  } finally {
    server?.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("stdio tool calls read the same disposable Markdown root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-main-"))
  const root = join(directory, ".slipmem")
  let server: ReturnType<typeof start> | undefined

  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({
        root,
        now: () => Date.UTC(2026, 10, 17, 12, 0, 0),
      }),
    )
    const note = await Effect.runPromise(
      repository.create({
        type: "fleeting",
        title: "From stdio",
        content: "written before the server started",
      }),
    )
    server = start(root, join(directory, "cache"))

    const reader = server.stdout!.getReader()
    initialize(server)
    await readLine(reader)
    send(server, { jsonrpc: "2.0", method: "notifications/initialized" })
    send(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_fleeting_note", arguments: { id: note.id } },
    })

    const response = JSON.parse(await readLine(reader)) as {
      readonly result?: {
        readonly structuredContent?: {
          readonly note?: { readonly id?: string; readonly title?: string }
        }
      }
    }
    expect(response.result?.structuredContent?.note).toEqual(
      expect.objectContaining({ id: note.id, title: "From stdio" }),
    )

    server.kill("SIGINT")
    expect(await server.exited).toBe(0)
  } finally {
    server?.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
