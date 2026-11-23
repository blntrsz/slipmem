#!/usr/bin/env bun
/**
 * Offline end-to-end smoke test for opt-in slipmem automatic memory.
 *
 * This is intentionally a standalone operator/validation script, not part of
 * the normal `bun test` suite. It launches a Bun mock loopback
 * `/chat/completions` server, uses an isolated temporary note root, and drives
 * the real MCP surface. It never uses a live provider credential.
 *
 * Two modes are supported:
 *
 *   runtime (default)
 *     Launches the integrated MCP runtime (or an override command) and
 *     connects to its MCP surface. The default settings already use the
 *     integrated opt-in names; the command and environment remain
 *     overridable through SLIPMEM_E2E_RUNTIME_CMD and
 *     SLIPMEM_E2E_RUNTIME_ENV (or a JSON file).
 *
 *   inline
 *     Works with the current tree without the integrated lifecycle. The script
 *     starts the existing stdio MCP server for raw writes/approvals and runs
 *     one bounded maintenance worker in-process with the core maintenance API.
 *     This is the reference shape the integrated runtime must preserve.
 *
 * Usage:
 *   bun scripts/automatic-memory-e2e.ts
 *
 *   SLIPMEM_E2E_MODE=inline bun scripts/automatic-memory-e2e.ts
 *
 * Runtime mode defaults to the integrated MCP server:
 *   bun packages/mcp/src/main.ts
 * with the exact opt-in settings:
 *   SLIPMEM_AUTO_MEMORY=on
 *   SLIPMEM_CHAT_PROVIDER=openai-compatible
 *   SLIPMEM_CHAT_BASE_URL=${MOCK_BASE_URL}
 *   SLIPMEM_CHAT_MODEL=${MODEL}
 *   SLIPMEM_CHAT_API_KEY=${API_KEY}
 * The runtime is event-driven: one recovery pass runs at startup and each raw
 * fleeting/literature write wakes another pass. Override the command or
 * environment when the integration changes:
 *
 *   SLIPMEM_E2E_MODE=runtime \
 *   SLIPMEM_E2E_RUNTIME_CMD='bun packages/runtime/src/main.ts' \
 *   SLIPMEM_E2E_RUNTIME_ENV='{
 *     "SLIPMEM_AUTO_MEMORY":"on",
 *     "SLIPMEM_CHAT_PROVIDER":"openai-compatible",
 *     "SLIPMEM_CHAT_BASE_URL":"${MOCK_BASE_URL}",
 *     "SLIPMEM_CHAT_MODEL":"${MODEL}",
 *     "SLIPMEM_CHAT_API_KEY":"${API_KEY}"
 *   }' \
 *   bun scripts/automatic-memory-e2e.ts
 *
 * HTTP MCP is also supported:
 *   SLIPMEM_E2E_MODE=runtime \
 *   SLIPMEM_E2E_TRANSPORT=http \
 *   SLIPMEM_E2E_HTTP_URL='http://127.0.0.1:3317/mcp' \
 *   SLIPMEM_E2E_RUNTIME_CMD='PORT=3317 bun run web' \
 *   bun scripts/automatic-memory-e2e.ts
 *
 * Placeholders available in the command, URL, and environment JSON:
 *   ${ROOT}             isolated .slipmem directory
 *   ${CACHE_DIR}        isolated XDG cache directory
 *   ${STATE_DIR}        isolated XDG state directory
 *   ${BASE_DIR}         isolated temporary parent directory
 *   ${MOCK_BASE_URL}    loopback mock provider, e.g. http://127.0.0.1:1234
 *   ${MOCK_V1_URL}      like ${MOCK_BASE_URL} but with /v1
 *   ${MODEL}            mock model identifier
 *   ${API_KEY}          fixed non-secret test key
 *   ${NONCE}            per-run identifier
 *
 * Optional settings:
 *   SLIPMEM_E2E_WAIT_MS                 worker/readiness timeout (default 90000)
 *   SLIPMEM_E2E_POLL_MS                 poll interval (default 200)
 *   SLIPMEM_E2E_RAW_WRITE_TIMEOUT_MS    raw write must beat a blocked model
 *                                       call (default 3000)
 *   SLIPMEM_E2E_RUNTIME_CWD             runtime working directory
 *   SLIPMEM_E2E_RUNTIME_ENV_FILE        JSON file with runtime env
 *   SLIPMEM_E2E_NO_DEFAULT_ENV=1        do not inject the default auto-memory env
 *   SLIPMEM_E2E_KEEP=1                  keep the temporary root
 *   SLIPMEM_E2E_KEEP_ON_FAILURE=0       delete the temporary root on failure
 *   SLIPMEM_E2E_VERBOSE=1               print every mocked request
 *
 * No live provider credentials are read. Known credential and provider
 * variables are removed from every child environment before the runtime starts,
 * and the defaults above then inject only the loopback mock endpoint.
 */

import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "../packages/core/node_modules/effect/dist/index.js"
import { initializeNoteRoot } from "../packages/core/src/markdown/root.ts"
import { makeMarkdownNoteRepository } from "../packages/core/src/markdown/repository.ts"

type JsonRecord = Record<string, any>

interface MockRecord {
  readonly path: string
  readonly model: string
  readonly prompt: string
  readonly messageCount: number
  readonly hasTools: boolean
  readonly authorization: string | null
}

interface ToolResult {
  readonly structuredContent?: JsonRecord
  readonly content?: ReadonlyArray<{ readonly text?: string }>
  readonly isError?: boolean
}

interface McpClient {
  readonly callTool: (name: string, args: JsonRecord) => Promise<ToolResult>
  readonly close: () => Promise<void>
  readonly diagnostics: () => string
}

interface SpawnedProcess {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly tail: ProcessTail
}

interface E2EContext {
  readonly base: string
  readonly root: string
  readonly cacheDir: string
  readonly stateDir: string
  readonly mock: ReturnType<typeof Bun.serve>
  readonly mockBaseUrl: string
  readonly records: MockRecord[]
  readonly nonce: string
  readonly generatedTitle: string
  readonly generatedContent: string
  processTail: ProcessTail | null
  mcp: McpClient | null
  rawWriteReturned: boolean
  providerBlocked: boolean
}

const repoRoot = resolve(import.meta.dir, "..")
const env = process.env
const mode = (env.SLIPMEM_E2E_MODE?.trim() || "runtime").toLowerCase()
const transport = (env.SLIPMEM_E2E_TRANSPORT?.trim() || "stdio").toLowerCase()
// The integrated runtime runs one startup recovery pass and wakes on each raw
// write. The generous default still covers a slow startup or an overridden
// runtime command; inline mode returns immediately.
const waitMs = integerEnv("SLIPMEM_E2E_WAIT_MS", 90_000, 1_000, 300_000)
const pollMs = integerEnv("SLIPMEM_E2E_POLL_MS", 200, 20, 5_000)
const rawWriteTimeoutMs = integerEnv(
  "SLIPMEM_E2E_RAW_WRITE_TIMEOUT_MS",
  3_000,
  250,
  60_000,
)
const model = env.SLIPMEM_E2E_MODEL?.trim() || "slipmem-e2e-offline-model"
const apiKey = env.SLIPMEM_E2E_API_KEY?.trim() || "offline-e2e-not-a-secret"
const verbose = env.SLIPMEM_E2E_VERBOSE === "1"

const CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "SLIPMEM_OPENAI_API_KEY",
  "SLIPMEM_OPENAI_BASE_URL",
  "SLIPMEM_OPENAI_MODEL",
  "SLIPMEM_MODEL_API_KEY",
  "SLIPMEM_MODEL_BASE_URL",
  "SLIPMEM_MODEL",
  "SLIPMEM_CHAT_API_KEY",
  "SLIPMEM_CHAT_BASE_URL",
  "SLIPMEM_CHAT_MODEL",
  "SLIPMEM_CHAT_PROVIDER",
  "SLIPMEM_MAINTENANCE_API_KEY",
  "SLIPMEM_MAINTENANCE_BASE_URL",
  "SLIPMEM_MAINTENANCE_MODEL",
  "SLIPMEM_MAINTENANCE_PROVIDER",
  "SLIPMEM_CAPTURE_API_KEY",
  "SLIPMEM_CAPTURE_BASE_URL",
  "SLIPMEM_CAPTURE_MODEL",
  "SLIPMEM_CAPTURE_PROVIDER",
  "SLIPMEM_AUTO_MEMORY",
  "SLIPMEM_AUTO_MEMORY_RUN_ON_START",
  "SLIPMEM_AUTO_MEMORY_INTERVAL_MS",
  "SLIPMEM_RECALL_PROVIDER",
  "SLIPMEM_RECALL_JEV_MODEL",
  "TYPESAFE_API_KEY",
]

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === "") {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${raw}.`)
  }
  return value
}

const check = (condition: unknown, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const sleep = (ms: number): Promise<void> => Bun.sleep(ms)

const appendTail = (current: string, chunk: string): string =>
  (current + chunk).slice(-12_000)

const consumeStream = async (
  stream: ReadableStream<Uint8Array> | null,
  sink: (text: string) => void,
): Promise<void> => {
  if (stream === null) {
    return
  }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      sink(decoder.decode(value, { stream: true }))
    }
    sink(decoder.decode())
  } catch {
    // Process teardown closes the stream. Diagnostics already contain the tail.
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released.
    }
  }
}

class ProcessTail {
  readonly proc: ReturnType<typeof Bun.spawn>
  private stderrText = ""
  private stdoutText = ""
  private closing = false

  constructor(
    proc: ReturnType<typeof Bun.spawn>,
    options: { readonly drainStdout: boolean },
  ) {
    this.proc = proc
    void consumeStream(proc.stderr, (text) => {
      this.stderrText = appendTail(this.stderrText, text)
    })
    if (options.drainStdout) {
      void consumeStream(proc.stdout, (text) => {
        this.stdoutText = appendTail(this.stdoutText, text)
      })
    }
  }

  stderrTail(): string {
    return this.stderrText.trim()
  }

  stdoutTail(): string {
    return this.stdoutText.trim()
  }

  async close(): Promise<void> {
    if (this.closing) {
      return
    }
    this.closing = true
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // Already exited.
    }
    await Promise.race([this.proc.exited, sleep(1_500)])
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGKILL")
      } catch {
        // Already exited.
      }
      await Promise.race([this.proc.exited, sleep(1_500)])
    }
  }
}

const spawnProcess = (
  argv: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: Record<string, string>
    readonly stdio: boolean
  },
): SpawnedProcess => {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdio ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const tail = new ProcessTail(proc, { drainStdout: !options.stdio })
  return { proc, tail }
}

const parseSourceIds = (prompt: string): ReadonlyArray<string> => {
  const trimmed = prompt.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1] !== undefined) {
    candidates.push(fence[1].trim())
  }
  const objectStart = trimmed.indexOf("{")
  if (objectStart >= 0) {
    candidates.push(trimmed.slice(objectStart))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonRecord
      if (Array.isArray(parsed.untrustedSources)) {
        return parsed.untrustedSources
          .map((source) => asRecord(source)?.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      }
    } catch {
      // Try the next candidate.
    }
  }
  return []
}

const makeGate = (): { readonly promise: Promise<void>; readonly release: () => void } => {
  let release!: () => void
  const promise = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  return { promise, release }
}

const startMockProvider = (context: {
  readonly nonce: string
  readonly generatedTitle: string
  readonly generatedContent: string
  readonly records: MockRecord[]
  readonly state: {
    expectedSourceIds: string[]
    blockProvider: boolean
    blockedRequests: number
    gate: { readonly promise: Promise<void>; readonly release: () => void }
  }
}): { readonly server: ReturnType<typeof Bun.serve>; readonly baseUrl: string } => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (
        request.method !== "POST" ||
        !url.pathname.endsWith("/chat/completions")
      ) {
        return new Response("not found", { status: 404 })
      }

      let body: JsonRecord = {}
      try {
        body = (await request.json()) as JsonRecord
      } catch {
        return Response.json(
          { error: { message: "invalid JSON body" } },
          { status: 400 },
        )
      }

      const messages = Array.isArray(body.messages) ? body.messages : []
      const prompt = messages
        .map((message) =>
          asRecord(message)?.content !== undefined &&
          typeof asRecord(message)?.content === "string"
            ? (asRecord(message)!.content as string)
            : "",
        )
        .join("\n")
      const record: MockRecord = {
        path: url.pathname,
        model: typeof body.model === "string" ? body.model : "",
        prompt,
        messageCount: messages.length,
        hasTools: body.tools !== undefined || body.functions !== undefined,
        authorization: request.headers.get("authorization"),
      }
      context.records.push(record)
      if (verbose) {
        console.log(
          `[mock] ${record.path} messages=${record.messageCount} model=${record.model} tools=${record.hasTools}`,
        )
      }

      // Capture the response inputs before the optional gate. A request that
      // arrived before the raw write must not suddenly see the source ID that
      // was created while it was blocked.
      const fromPrompt = parseSourceIds(prompt)
      const expected = context.state.expectedSourceIds[0]
      const sourceId =
        expected !== undefined && fromPrompt.includes(expected)
          ? expected
          : fromPrompt[0] ?? expected

      if (context.state.blockProvider) {
        context.state.blockedRequests += 1
        await context.state.gate.promise
      }

      const operations =
        sourceId === undefined
          ? []
          : [
              {
                operation: "create",
                title: context.generatedTitle,
                content: context.generatedContent,
                tags: ["e2e", "generated"],
                sourceIds: [sourceId],
              },
            ]

      return Response.json({
        id: `chatcmpl-${context.nonce}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: record.model || model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ operations }),
            },
            finish_reason: "stop",
          },
        ],
      })
    },
  })

  return { server, baseUrl: `http://127.0.0.1:${server.port}` }
}

const substitute = (text: string, values: Readonly<Record<string, string>>): string => {
  let result = text
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`\${${key}}`, value)
  }
  return result
}

const substituteValues = (context: E2EContext): Record<string, string> => ({
  ROOT: context.root,
  CACHE_DIR: context.cacheDir,
  STATE_DIR: context.stateDir,
  BASE_DIR: context.base,
  MOCK_BASE_URL: context.mockBaseUrl,
  MOCK_V1_URL: `${context.mockBaseUrl}/v1`,
  MODEL: model,
  API_KEY: apiKey,
  NONCE: context.nonce,
})

const cleanBaseEnv = (): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      result[key] = value
    }
  }
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete result[key]
  }
  return result
}

const childEnv = (
  context: E2EContext,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  ...cleanBaseEnv(),
  SLIPMEM_DIR: context.root,
  XDG_CACHE_HOME: context.cacheDir,
  XDG_STATE_HOME: context.stateDir,
  ...extra,
})

const readRuntimeEnv = async (context: E2EContext): Promise<Record<string, string>> => {
  const extra: Record<string, string> = {}
  const values = substituteValues(context)

  if (env.SLIPMEM_E2E_NO_DEFAULT_ENV !== "1") {
    // Canonical primary-chat names for the event-driven MCP runtime. The
    // startup recovery pass and the raw-write wake both use this one model;
    // legacy SLIPMEM_MAINTENANCE_* names are not needed here.
    Object.assign(
      extra,
      {
        SLIPMEM_AUTO_MEMORY: "on",
        SLIPMEM_CHAT_PROVIDER: "openai-compatible",
        SLIPMEM_CHAT_BASE_URL: values.MOCK_BASE_URL,
        SLIPMEM_CHAT_MODEL: values.MODEL,
        SLIPMEM_CHAT_API_KEY: values.API_KEY,
      },
    )
  }

  const inlineJson = env.SLIPMEM_E2E_RUNTIME_ENV?.trim()
  const file = env.SLIPMEM_E2E_RUNTIME_ENV_FILE?.trim()
  let raw = inlineJson
  if (raw === undefined || raw === "") {
    if (file !== undefined && file !== "") {
      raw = await readFile(resolve(repoRoot, substitute(file, values)), "utf8")
    }
  }
  if (raw !== undefined && raw !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(substitute(raw, values))
    } catch (error) {
      throw new Error(
        `SLIPMEM_E2E_RUNTIME_ENV must be a JSON object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    check(asRecord(parsed) !== null, "SLIPMEM_E2E_RUNTIME_ENV must be a JSON object.")
    for (const [key, value] of Object.entries(parsed as JsonRecord)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        extra[key] = String(value)
      }
    }
  }

  return extra
}

const defaultRuntimeCommand = (): ReadonlyArray<string> => {
  check(
    transport === "stdio",
    "HTTP runtime mode requires SLIPMEM_E2E_RUNTIME_CMD (for example, a server that mounts /mcp).",
  )
  return [process.execPath, "packages/mcp/src/main.ts"]
}

const runtimeArgv = (context: E2EContext): ReadonlyArray<string> => {
  const raw = env.SLIPMEM_E2E_RUNTIME_CMD?.trim()
  if (raw === undefined || raw === "") {
    return defaultRuntimeCommand()
  }
  const command = substitute(raw, substituteValues(context))
  if (command.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(command)
    } catch (error) {
      throw new Error(
        `SLIPMEM_E2E_RUNTIME_CMD JSON array is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    check(
      Array.isArray(parsed) && parsed.every((item) => typeof item === "string"),
      "SLIPMEM_E2E_RUNTIME_CMD JSON form must be an array of strings.",
    )
    return parsed as ReadonlyArray<string>
  }
  return ["bash", "-lc", command]
}

const httpMcpUrl = (context: E2EContext): string => {
  const explicit = env.SLIPMEM_E2E_HTTP_URL?.trim()
  if (explicit !== undefined && explicit !== "") {
    return substitute(explicit, substituteValues(context))
  }
  const port = env.SLIPMEM_E2E_PORT?.trim()
  check(
    port !== undefined && port !== "",
    "HTTP transport requires SLIPMEM_E2E_HTTP_URL or SLIPMEM_E2E_PORT.",
  )
  return `http://127.0.0.1:${port}/mcp`
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

class StdioMcp implements McpClient {
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly timeoutMs: number
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: Error) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >()
  private nextId = 1
  private buffer = ""
  private closed = false

  constructor(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
    check(proc.stdin !== undefined && proc.stdin !== null, "stdio MCP stdin is not piped.")
    check(proc.stdout !== null, "stdio MCP stdout is not piped.")
    this.proc = proc
    this.timeoutMs = timeoutMs
    this.reader = proc.stdout.getReader()
    void this.readLoop()
    void this.watchExit()
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) {
          break
        }
        this.buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const newline = this.buffer.indexOf("\n")
          if (newline < 0) {
            break
          }
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line !== "") {
            this.handleLine(line)
          }
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.rejectAll(
          new Error(
            `stdio MCP stream failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
      }
    } finally {
      try {
        this.reader.releaseLock()
      } catch {
        // Already released.
      }
      if (!this.closed) {
        this.rejectAll(
          new Error(
            `stdio MCP closed before a response (exit ${String(this.proc.exitCode)}).`,
          ),
        )
      }
    }
  }

  private async watchExit(): Promise<void> {
    const code = await this.proc.exited
    if (!this.closed) {
      this.rejectAll(
        new Error(`stdio MCP process exited with code ${String(code)} before a response.`),
      )
    }
  }

  private handleLine(line: string): void {
    let message: JsonRecord
    try {
      message = JSON.parse(line) as JsonRecord
    } catch {
      return
    }
    if (typeof message.id !== "number") {
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      pending.reject(
        new Error(
          `MCP ${String(asRecord(message.error)?.message ?? "request failed")}`,
        ),
      )
      return
    }
    pending.resolve(message.result)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private send(message: JsonRecord): void {
    check(this.proc.stdin !== undefined && this.proc.stdin !== null, "MCP stdin closed.")
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
    this.proc.stdin.flush()
  }

  private request(method: string, params: JsonRecord = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms.`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectRequest(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: JsonRecord = {}): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  async start(): Promise<void> {
    const result = asRecord(
      await this.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "slipmem-automatic-memory-e2e", version: "0.0.0" },
      }),
    )
    check(result !== null, "MCP initialize returned no result.")
    this.notify("notifications/initialized")
    await sleep(10)
  }

  async callTool(name: string, args: JsonRecord): Promise<ToolResult> {
    const result = asRecord(
      await this.request("tools/call", { name, arguments: args }),
    )
    check(result !== null, `MCP tools/call ${name} returned no result.`)
    return result as ToolResult
  }

  diagnostics(): string {
    return `stdio MCP exit=${String(this.proc.exitCode)}`
  }

  async close(): Promise<void> {
    this.closed = true
    this.rejectAll(new Error("MCP client closed."))
    try {
      await this.reader.cancel()
    } catch {
      // Already closed.
    }
  }
}

const parseRpcText = (
  text: string,
  contentType: string,
): ReadonlyArray<JsonRecord> => {
  if (contentType.includes("text/event-stream")) {
    const messages: JsonRecord[] = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n")
      if (data !== "") {
        try {
          const parsed = asRecord(JSON.parse(data))
          if (parsed !== null) {
            messages.push(parsed)
          }
        } catch {
          // Ignore keep-alive or non-JSON events.
        }
      }
    }
    return messages
  }
  try {
    const parsed = asRecord(JSON.parse(text))
    return parsed === null ? [] : [parsed]
  } catch {
    return []
  }
}

class HttpMcp implements McpClient {
  private readonly url: string
  private readonly timeoutMs: number
  private sessionId: string | null = null
  private nextId = 1
  private lastError: string | null = null

  constructor(url: string, timeoutMs: number) {
    this.url = url
    this.timeoutMs = timeoutMs
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(this.sessionId === null ? {} : { "mcp-session-id": this.sessionId }),
    }
  }

  private async post(
    message: JsonRecord,
    options: { readonly notification: boolean },
  ): Promise<JsonRecord | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      const session = response.headers.get("mcp-session-id")
      if (session !== null && session !== "") {
        this.sessionId = session
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        this.lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`
        throw new Error(`MCP HTTP ${this.lastError}`)
      }
      if (options.notification) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      const text = await response.text()
      const messages = parseRpcText(
        text,
        response.headers.get("content-type") ?? "",
      )
      if (messages.length === 0) {
        throw new Error("MCP HTTP returned no JSON-RPC message.")
      }
      const messageId = message.id
      const matching =
        messages.find((entry) => entry.id === messageId) ?? messages[0]!
      if (matching.error !== undefined) {
        throw new Error(
          `MCP HTTP ${String(asRecord(matching.error)?.message ?? "request failed")}`,
        )
      }
      return asRecord(matching.result) ?? {}
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private request(method: string, params: JsonRecord = {}): Promise<JsonRecord | null> {
    const id = this.nextId++
    return this.post({ jsonrpc: "2.0", id, method, params }, { notification: false })
  }

  private async notify(method: string, params: JsonRecord = {}): Promise<void> {
    await this.post(
      { jsonrpc: "2.0", method, params },
      { notification: true },
    )
  }

  async start(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "slipmem-automatic-memory-e2e", version: "0.0.0" },
    })
    await this.notify("notifications/initialized")
  }

  async callTool(name: string, args: JsonRecord): Promise<ToolResult> {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    })
    check(result !== null, `MCP HTTP tools/call ${name} returned no result.`)
    return result as ToolResult
  }

  diagnostics(): string {
    return `HTTP MCP ${this.url}${this.lastError === null ? "" : ` (${this.lastError})`}`
  }

  async close(): Promise<void> {
    // The streamable HTTP server owns session cleanup. Best-effort DELETE.
    if (this.sessionId === null) {
      return
    }
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(1_000),
      })
    } catch {
      // Best effort only.
    }
    this.sessionId = null
  }
}

const connectHttpWithRetry = async (
  url: string,
  processTail: ProcessTail | null,
): Promise<HttpMcp> => {
  const deadline = Date.now() + waitMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    const client = new HttpMcp(url, Math.min(5_000, waitMs))
    try {
      await client.start()
      return client
    } catch (error) {
      lastError = error
      await client.close()
      await sleep(pollMs)
    }
  }
  throw new Error(
    `MCP HTTP did not become ready at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }${processTail === null ? "" : `\nRuntime stderr:\n${processTail.stderrTail()}`}`,
  )
}

const toolStructured = (result: ToolResult): JsonRecord => {
  const structured = asRecord(result.structuredContent)
  if (structured !== null) {
    return structured
  }
  for (const item of result.content ?? []) {
    if (typeof item.text === "string") {
      try {
        const parsed = asRecord(JSON.parse(item.text))
        if (parsed !== null) {
          return parsed
        }
      } catch {
        // Not every MCP text block is JSON.
      }
    }
  }
  throw new Error(`MCP tool returned no structured content: ${JSON.stringify(result).slice(0, 500)}`)
}

const scanRoot = async (context: E2EContext) => {
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root: context.root,
      backupDir: join(context.base, "backups"),
      now: () => Date.now(),
    }),
  )
  return Effect.runPromise(repository.scan())
}

const isGeneratedPermanent = (note: any, rawId: string): boolean => {
  if (note.metadata.type !== "permanent") {
    return false
  }
  const maintenance = asRecord(note.unknown?.maintenance)
  const sources = Array.isArray(maintenance?.sources) ? maintenance.sources : []
  return (
    sources.some((source: unknown) => asRecord(source)?.id === rawId) ||
    note.metadata.provenance?.source === "maintenance"
  )
}

const readPendingProposals = async (
  context: E2EContext,
): Promise<ReadonlyArray<JsonRecord>> => {
  const directory = join(context.root, ".state", "pending")
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const proposals: JsonRecord[] = []
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const parsed = asRecord(
        JSON.parse(await readFile(join(directory, name), "utf8")),
      )
      if (parsed !== null) {
        proposals.push(parsed)
      }
    } catch {
      // Ignore malformed proposal files; the approval service reports them.
    }
  }
  return proposals
}

const waitFor = async <T>(
  label: string,
  probe: () => Promise<T | null | undefined>,
): Promise<T> => {
  const deadline = Date.now() + waitMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined && value !== false) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    await sleep(pollMs)
  }
  throw new Error(
    `Timed out after ${waitMs}ms waiting for ${label}.${
      lastError === null
        ? ""
        : ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    }`,
  )
}

const localChat = async (prompt: string, baseUrl: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  })
  if (!response.ok) {
    throw new Error(`mock provider returned HTTP ${response.status}`)
  }
  const body = (await response.json()) as JsonRecord
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error("mock provider returned no assistant content")
  }
  return content
}

const runInlineWorker = async (context: E2EContext, rawId: string): Promise<void> => {
  const maintenance = await import(
    "../packages/core/src/maintenance/index.ts"
  )
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root: context.root,
      backupDir: join(context.base, "backups"),
      now: () => Date.now(),
    }),
  )
  const provider = maintenance.makePromptMaintenanceProvider((prompt: string) =>
    Effect.tryPromise({
      try: () => localChat(prompt, context.mockBaseUrl),
      catch: (error) => error,
    }),
  )
  const worker = await Effect.runPromise(
    maintenance.makePermanentMaintenanceWorker(repository, {
      provider,
      now: () => Date.now(),
    }),
  )
  const result = await waitFor("inline maintenance worker write", async () => {
    const run = await Effect.runPromise(worker.run())
    return run.writes.length > 0 ? run : null
  })
  const writes = Array.isArray((result as JsonRecord).writes)
    ? ((result as JsonRecord).writes as ReadonlyArray<JsonRecord>)
    : []
  check(
    writes.some((write) => write.operation === "create"),
    "inline maintenance worker did not report a create write.",
  )
  if (verbose) {
    console.log(`[inline] worker source=${rawId} writes=${JSON.stringify(writes)}`)
  }
}

const startRuntime = async (
  context: E2EContext,
): Promise<{ readonly mcp: McpClient; readonly processTail: ProcessTail }> => {
  const values = substituteValues(context)
  const argv = mode === "inline"
    ? [process.execPath, "packages/mcp/src/main.ts"]
    : runtimeArgv(context)
  const extra = mode === "runtime" ? await readRuntimeEnv(context) : {}
  const cwd =
    mode === "runtime" && env.SLIPMEM_E2E_RUNTIME_CWD?.trim()
      ? resolve(repoRoot, substitute(env.SLIPMEM_E2E_RUNTIME_CWD.trim(), values))
      : repoRoot

  if (mode === "inline" && transport !== "stdio") {
    throw new Error("inline mode uses stdio MCP; set SLIPMEM_E2E_MODE=runtime for HTTP.")
  }

  const spawned = spawnProcess(argv, {
    cwd,
    env: childEnv(context, extra),
    stdio: transport === "stdio",
  })

  if (transport === "stdio") {
    const mcp = new StdioMcp(spawned.proc, waitMs)
    try {
      await mcp.start()
    } catch (error) {
      throw new Error(
        `MCP stdio did not initialize: ${
          error instanceof Error ? error.message : String(error)
        }\nRuntime command: ${argv.join(" ")}\nRuntime stderr:\n${spawned.tail.stderrTail()}`,
      )
    }
    return { mcp, processTail: spawned.tail }
  }

  const mcp = await connectHttpWithRetry(httpMcpUrl(context), spawned.tail)
  return { mcp, processTail: spawned.tail }
}

const printDiagnostics = async (
  context: E2EContext,
  error: unknown,
): Promise<void> => {
  console.error(`\nFAIL automatic-memory offline e2e (${mode}/${transport})`)
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  console.error(`temporary root: ${context.root}`)
  console.error(`mock /chat/completions calls: ${context.records.length}`)
  console.error(`mock provider blocked requests: ${context.providerBlocked ? "yes" : "no"}`)
  if (context.records.length > 0) {
    const maxShown = 12
    const shown =
      context.records.length <= maxShown
        ? context.records
        : [...context.records.slice(0, 8), ...context.records.slice(-4)]
    for (const [index, record] of shown.entries()) {
      console.error(
        `  mock[${index}] path=${record.path} messages=${record.messageCount} model=${record.model} tools=${record.hasTools}`,
      )
    }
    if (context.records.length > maxShown) {
      console.error(
        `  ... ${context.records.length - maxShown} more mock call(s) omitted`,
      )
    }
  }
  if (context.processTail !== null) {
    console.error(`runtime stderr tail:\n${context.processTail.stderrTail() || "(empty)"}`)
    const stdout = context.processTail.stdoutTail()
    if (stdout !== "") {
      console.error(`runtime stdout tail:\n${stdout}`)
    }
  }
  try {
    const entries = await readdir(context.root)
    console.error(`note root entries: ${entries.join(", ")}`)
  } catch {
    // The root may not have been created.
  }
  try {
    const pending = await readPendingProposals(context)
    console.error(
      `pending proposals: ${
        pending.length === 0
          ? "(none)"
          : pending.map((proposal) => proposal.id).join(", ")
      }`,
    )
  } catch {
    // Diagnostics are best effort.
  }
}

const teardown = async (context: E2EContext, success: boolean): Promise<void> => {
  try {
    await context.mcp?.close()
  } catch {
    // Best effort.
  }
  try {
    await context.processTail?.close()
  } catch {
    // Best effort.
  }
  try {
    context.mock.stop(true)
  } catch {
    // Best effort.
  }

  const keep =
    env.SLIPMEM_E2E_KEEP === "1" ||
    (!success && env.SLIPMEM_E2E_KEEP_ON_FAILURE !== "0")
  if (keep) {
    console.log(`kept temporary root: ${context.base}`)
  } else {
    await rm(context.base, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  check(mode === "inline" || mode === "runtime", `Unknown SLIPMEM_E2E_MODE=${mode}.`)
  check(transport === "stdio" || transport === "http", `Unknown SLIPMEM_E2E_TRANSPORT=${transport}.`)

  const nonce = crypto.randomUUID().slice(0, 8)
  const tempBase = env.SLIPMEM_E2E_TMP_BASE?.trim() || tmpdir()
  const base = await mkdtemp(join(tempBase, `slipmem-auto-memory-e2e-${nonce}-`))
  const root = join(base, ".slipmem")
  const cacheDir = join(base, "cache")
  const stateDir = join(base, "state")

  await Effect.runPromise(initializeNoteRoot(root))

  const records: MockRecord[] = []
  const mockState = {
    expectedSourceIds: [] as string[],
    blockProvider: false,
    blockedRequests: 0,
    gate: makeGate(),
  }
  const generatedTitle = `E2E generated memory ${nonce}`
  const generatedContent = `Offline end-to-end memory generated from raw capture ${nonce}.`
  const mock = startMockProvider({
    nonce,
    generatedTitle,
    generatedContent,
    records,
    state: mockState,
  })

  const context: E2EContext = {
    base,
    root,
    cacheDir,
    stateDir,
    mock: mock.server,
    mockBaseUrl: mock.baseUrl,
    records,
    nonce,
    generatedTitle,
    generatedContent,
    processTail: null,
    mcp: null,
    rawWriteReturned: false,
    providerBlocked: false,
  }

  let success = false
  try {
    console.log(`slipmem automatic-memory e2e (${mode}/${transport})`)
    console.log(`note root: ${root}`)
    console.log(`mock provider: ${context.mockBaseUrl} (loopback only)`)
    if (mode === "runtime") {
      console.log(`runtime command: ${runtimeArgv(context).join(" ")}`)
    }

    const started = await startRuntime(context)
    context.mcp = started.mcp
    context.processTail = started.processTail

    // In runtime mode, hold the model call until after the raw write returns.
    // This catches a runtime that makes normal writes wait for maintenance.
    if (mode === "runtime") {
      mockState.blockProvider = true
    }

    const rawTitle = `E2E raw capture ${nonce}`
    const rawBody = `Raw capture before maintenance ${nonce}. Keep this fleeting note.`
    let rawResult: ToolResult
    try {
      rawResult = await withTimeout(
        started.mcp.callTool("create_fleeting_note", {
          title: rawTitle,
          content: rawBody,
          tags: ["e2e", "raw"],
        }),
        rawWriteTimeoutMs,
        "normal raw fleeting write",
      )
    } finally {
      context.providerBlocked = mockState.blockedRequests > 0
      mockState.blockProvider = false
      mockState.gate.release()
    }
    context.rawWriteReturned = true

    check(rawResult.isError !== true, "raw fleeting write was reported as an error.")
    const raw = toolStructured(rawResult)
    check(typeof raw.id === "string" && raw.id.length > 0, "raw fleeting write returned no note ID.")
    check(raw.type === "fleeting", `raw write must be fleeting, got ${String(raw.type)}.`)
    check(raw.title === rawTitle, "raw fleeting write returned the wrong title.")
    check(raw.content === rawBody, "raw fleeting write returned the wrong body.")
    check(raw.status === undefined, "raw fleeting write must return a note, not a pending proposal.")
    check(
      existsSync(join(root, `${raw.id}.md`)),
      `raw fleeting note file ${raw.id}.md was not written before the worker ran.`,
    )
    mockState.expectedSourceIds = [raw.id]
    console.log(
      `[ok] normal raw write returned directly: ${raw.id}${
        context.providerBlocked ? " (model call was blocked)" : ""
      }`,
    )

    if (mode === "inline") {
      await runInlineWorker(context, raw.id)
      console.log("[ok] inline worker completed one bounded maintenance pass")
    }

    const generated = await waitFor("worker-generated permanent note", async () => {
      const scan = await scanRoot(context)
      const matches = scan.notes.filter((note) => isGeneratedPermanent(note, raw.id))
      if (matches.length === 0) {
        return null
      }
      check(
        matches.length === 1,
        `worker created ${matches.length} generated permanents instead of one: ${matches
          .map((note) => note.id)
          .join(", ")}`,
      )
      return matches[0]!
    })

    check(records.length > 0, "mock /chat/completions was never called.")
    check(
      records.every((record) => !record.hasTools),
      "maintenance provider request included tools; the maintenance boundary must not offer tools.",
    )
    check(
      records.every((record) => record.path.endsWith("/chat/completions")),
      "runtime called a path other than /chat/completions.",
    )
    check(
      records.some((record) => record.prompt.includes(rawBody)),
      "the maintenance provider request did not include the raw note body as bounded input.",
    )

    check(generated.metadata.type === "permanent", "generated note is not permanent.")
    check(
      generated.metadata.title === generatedTitle,
      `generated permanent title mismatch: ${generated.metadata.title}`,
    )
    check(
      generated.body === generatedContent,
      "generated permanent body did not come from the mocked completion.",
    )
    check(
      generated.metadata.provenance?.source === "maintenance",
      "generated permanent is missing maintenance provenance.",
    )
    check(
      generated.metadata.provenance?.actor === "slipmem-maintenance",
      "generated permanent has the wrong maintenance actor.",
    )
    const maintenance = asRecord(generated.unknown.maintenance)
    check(maintenance !== null, "generated permanent is missing the maintenance marker.")
    check(
      Array.isArray(maintenance.sources) &&
        maintenance.sources.some((source: unknown) => asRecord(source)?.id === raw.id),
      "generated permanent does not record the consumed raw source.",
    )
    check(
      generated.metadata.tags?.includes("generated") === true,
      "generated permanent did not preserve mocked tags.",
    )
    console.log(
      `[ok] worker created one generated permanent: ${generated.id} (source ${raw.id})`,
    )

    const externalTitle = `External permanent ${nonce}`
    const externalBody = `External MCP permanent write that must wait for human approval ${nonce}.`
    const externalResult = await started.mcp.callTool("create_permanent_note", {
      title: externalTitle,
      content: externalBody,
      tags: ["external"],
    })
    check(
      externalResult.isError !== true,
      "external permanent write was reported as an error instead of a pending proposal.",
    )
    const external = toolStructured(externalResult)
    check(
      external.status === "pending_approval",
      `external permanent write must be pending_approval, got ${JSON.stringify(external)}.`,
    )
    check(
      typeof external.proposalId === "string" && external.proposalId.length > 0,
      "external permanent proposal has no proposalId.",
    )

    const pending = await readPendingProposals(context)
    check(
      pending.length === 1,
      `expected exactly one pending proposal, found ${pending.length}.`,
    )
    const proposal = pending[0]!
    check(
      proposal.id === external.proposalId,
      "pending proposal ID does not match the MCP response.",
    )
    check(proposal.operation === "create", `pending proposal operation was ${String(proposal.operation)}.`)
    check(
      proposal.source === "mcp",
      `pending proposal source was ${String(proposal.source)}, expected mcp.`,
    )
    check(
      proposal.noteId !== generated.id,
      "external permanent proposal unexpectedly targets the generated note.",
    )
    check(
      !existsSync(join(root, `${proposal.noteId}.md`)),
      "external permanent proposal wrote a note file before approval.",
    )

    const after = await scanRoot(context)
    const permanents = after.notes.filter((note) => note.metadata.type === "permanent")
    check(
      permanents.length === 1,
      `expected one permanent note after the external proposal, found ${permanents.length}.`,
    )
    check(
      permanents.every((note) => note.metadata.title !== externalTitle),
      "external permanent write appeared on disk without human approval.",
    )

    const listed = toolStructured(
      await started.mcp.callTool("list_permanent_notes", { limit: 50 }),
    )
    const listedNotes = Array.isArray(listed.notes) ? listed.notes : []
    check(
      listedNotes.some((note: unknown) => asRecord(note)?.id === generated.id),
      "generated permanent is not visible through MCP list_permanent_notes.",
    )
    check(
      listedNotes.every((note: unknown) => asRecord(note)?.title !== externalTitle),
      "external pending permanent is visible through MCP list_permanent_notes.",
    )

    console.log(
      `[ok] external permanent write remained pending: ${String(proposal.id)} (no note file)`,
    )
    console.log(
      `[ok] mock /chat/completions used ${records.length} time(s); no live provider credential read`,
    )
    console.log(`PASS automatic-memory offline e2e (${mode}/${transport})`)
    success = true
  } catch (error) {
    await printDiagnostics(context, error)
    throw error
  } finally {
    await teardown(context, success)
  }
}

try {
  await main()
} catch {
  process.exitCode = 1
}
