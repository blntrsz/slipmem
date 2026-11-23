import { initializeNoteRoot, makeMarkdownNoteRepository } from "@slipmem/core"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Process-level offline acceptance for the event-driven automatic-memory
 * runtime.
 *
 * The test deliberately drives the real stdio MCP entrypoint instead of the
 * in-memory Effect test client, so startup wiring, the raw-write wake path, the
 * loopback chat transport, prompt recall, and restart behavior are exercised as
 * an MCP host sees them.
 *
 * Scenario:
 *   1. Start the runtime with a loopback OpenAI-compatible chat model and no
 *      Jev/TypeSafe provider.
 *   2. Submit one raw fleeting note through the real MCP surface. The
 *      event-driven runtime must consolidate it immediately in the same
 *      process, with no periodic interval and no second process.
 *   3. Call `recall_prompt`. With Jev off, the same primary chat model is the
 *      recall evaluator, so the result must be a typed relevance decision.
 *   4. Restart against the same note root. Durable revision receipts must keep
 *      the already-consolidated raw note from being written twice and must not
 *      call the provider again.
 *
 * A minimal child environment is used so no ambient provider credential or Jev
 * key can leak into the runtime.
 */

const repositoryRoot = resolve(import.meta.dir, "../../..")
const runtimeEntrypoint = join(repositoryRoot, "packages/mcp/src/main.ts")
const model = "acceptance-loopback-model"
const apiKey = "offline-acceptance-not-a-secret"

interface JsonRecord {
  readonly [key: string]: unknown
}

interface MockRecord {
  readonly path: string
  readonly kind: "maintenance" | "recall" | "unknown"
  readonly model: string
  readonly prompt: string
  readonly userPrompt: string
  readonly sourceIds: ReadonlyArray<string>
  readonly hasTools: boolean
  readonly authorization: string | null
}

interface ToolResult {
  readonly isError?: boolean
  readonly structuredContent?: unknown
  readonly content?: ReadonlyArray<{ readonly text?: string }>
}

interface ToolClient {
  readonly callTool: (name: string, args: JsonRecord) => Promise<ToolResult>
  readonly close: () => Promise<void>
  readonly stderr: () => string
}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const sleep = (milliseconds: number): Promise<void> =>
  Bun.sleep(milliseconds)

const structured = (result: ToolResult): JsonRecord => {
  const value = asRecord(result.structuredContent)
  if (value === null) {
    throw new Error(
      `MCP tool returned no structured content: ${JSON.stringify(result).slice(0, 500)}`,
    )
  }
  return value
}

const parseSourceIds = (prompt: string): ReadonlyArray<string> => {
  try {
    const request = asRecord(JSON.parse(prompt))
    if (request === null || !Array.isArray(request.untrustedSources)) {
      return []
    }
    return request.untrustedSources
      .map((source) => asRecord(source)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  } catch {
    return []
  }
}

const startMockProvider = (options: {
  readonly nonce: string
  readonly generatedTitle: string
  readonly generatedContent: string
  readonly records: MockRecord[]
}) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (
        request.method !== "POST" ||
        url.pathname !== "/chat/completions"
      ) {
        return new Response("not found", { status: 404 })
      }

      let body: JsonRecord
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
        .map((message) => {
          const value = asRecord(message)
          return typeof value?.content === "string" ? value.content : ""
        })
        .join("\n")
      const userPrompt =
        messages
          .map((message) => asRecord(message))
          .filter((message) => message?.role === "user")
          .map((message) => message?.content)
          .filter((content): content is string => typeof content === "string")
          .at(-1) ?? ""

      let requestShape: JsonRecord | null = null
      try {
        requestShape = asRecord(JSON.parse(userPrompt))
      } catch {
        requestShape = null
      }
      const recallNote = asRecord(requestShape?.note)
      const kind: MockRecord["kind"] = Array.isArray(
        requestShape?.untrustedSources,
      )
        ? "maintenance"
        : typeof requestShape?.query === "string" &&
            recallNote !== null &&
            typeof recallNote.id === "string"
          ? "recall"
          : "unknown"
      const sourceIds = kind === "maintenance" ? parseSourceIds(userPrompt) : []
      const record: MockRecord = {
        path: url.pathname,
        kind,
        model: typeof body.model === "string" ? body.model : "",
        prompt,
        userPrompt,
        sourceIds,
        hasTools: body.tools !== undefined || body.functions !== undefined,
        authorization: request.headers.get("authorization"),
      }
      options.records.push(record)

      if (kind === "unknown") {
        return Response.json(
          { error: { message: "unrecognized bounded chat request" } },
          { status: 422 },
        )
      }

      const content =
        kind === "recall"
          ? JSON.stringify({ verdict: "relevant", confidence: 0.9 })
          : JSON.stringify({
              operations:
                sourceIds.length === 0
                  ? []
                  : [
                      {
                        operation: "create",
                        title: options.generatedTitle,
                        content: options.generatedContent,
                        tags: ["acceptance", "generated"],
                        // The worker selects one pending fleeting source. Keep
                        // the operation scoped to it so a duplicate is obvious.
                        sourceIds: [sourceIds[0]],
                      },
                    ],
            })

      return Response.json({
        id: `chatcmpl-${options.nonce}-${options.records.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: record.model || model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
            },
            finish_reason: "stop",
          },
        ],
      })
    },
  })

  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error("Loopback mock provider did not receive a port.")
  }

  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

/**
 * Minimal NDJSON MCP client over a real child process.
 *
 * Only the methods this acceptance path needs are implemented. Stderr is
 * drained continuously so a noisy startup cannot block the child, and retained
 * for failure diagnostics.
 */
interface PipeSink {
  readonly write: (chunk: string) => unknown
  readonly flush: () => unknown
  readonly end: () => unknown
}

class StdioClient implements ToolClient {
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly stdin: PipeSink
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: Error) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly stderrRead: Promise<string>
  private stderrText = ""
  private nextId = 1
  private buffer = ""
  private closed = false

  constructor(proc: ReturnType<typeof Bun.spawn>) {
    const stdin = proc.stdin
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("stdio MCP stdin is not piped.")
    }
    const stdout = proc.stdout
    if (stdout === undefined || typeof stdout === "number") {
      throw new Error("stdio MCP stdout is not piped.")
    }
    const stderr = proc.stderr
    if (stderr === undefined || typeof stderr === "number") {
      throw new Error("stdio MCP stderr is not piped.")
    }
    this.proc = proc
    this.stdin = stdin
    this.reader = stdout.getReader()
    this.stderrRead = this.collectStderr(stderr)
    void this.readLoop()
  }

  private async collectStderr(
    stream: ReadableStream<Uint8Array> | null,
  ): Promise<string> {
    if (stream === null) {
      return ""
    }
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        this.stderrText = (this.stderrText + decoder.decode(value, { stream: true })).slice(
          -12_000,
        )
      }
      this.stderrText = (this.stderrText + decoder.decode()).slice(-12_000)
    } catch {
      // Process teardown closes the stream.
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Already released.
      }
    }
    return this.stderrText
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
    } catch {
      // Process teardown closes the stream.
    } finally {
      try {
        this.reader.releaseLock()
      } catch {
        // Already released.
      }
      if (!this.closed) {
        this.rejectPending(
          new Error(
            `stdio MCP closed before a response (exit ${String(this.proc.exitCode)}).`,
          ),
        )
      }
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
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) {
      return
    }
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) {
      const error = asRecord(message.error)
      waiter.reject(
        new Error(`MCP error: ${String(error?.message ?? "request failed")}`),
      )
      return
    }
    waiter.resolve(message.result)
  }

  private rejectPending(error: Error): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private send(message: JsonRecord): void {
    this.stdin.write(`${JSON.stringify(message)}\n`)
    this.stdin.flush()
  }

  private request(
    method: string,
    params: JsonRecord,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(
          new Error(`MCP ${method} timed out after ${timeoutMs}ms.`),
        )
      }, timeoutMs)
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

  private notify(method: string, params: JsonRecord): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  async initialize(): Promise<void> {
    const result = asRecord(
      await this.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "slipmem-automatic-memory-acceptance",
          version: "0.0.0",
        },
      }),
    )
    if (result === null) {
      throw new Error("MCP initialize returned no result.")
    }
    this.notify("notifications/initialized", {})
  }

  async callTool(name: string, args: JsonRecord): Promise<ToolResult> {
    const result = asRecord(
      await this.request("tools/call", { name, arguments: args }),
    )
    if (result === null) {
      throw new Error(`MCP tools/call ${name} returned no result.`)
    }
    return result as ToolResult
  }

  stderr(): string {
    return this.stderrText.trim()
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.rejectPending(new Error("MCP client closed."))
    try {
      this.stdin.end()
    } catch {
      // Already closed.
    }
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // Already exited.
    }
    const killTimer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL")
      } catch {
        // Already exited.
      }
    }, 2_000)
    await this.proc.exited
    clearTimeout(killTimer)
    try {
      await this.reader.cancel()
    } catch {
      // Already closed.
    }
    await this.stderrRead
  }
}

const startRuntime = async (options: {
  readonly name: string
  readonly root: string
  readonly cacheDir: string
  readonly stateDir: string
  readonly homeDir: string
  readonly mockBaseUrl: string
}): Promise<{ readonly client: StdioClient }> => {
  const proc = Bun.spawn([process.execPath, runtimeEntrypoint], {
    cwd: repositoryRoot,
    // A minimal environment, not a copy of the host environment. This proves
    // the test uses only the fixed offline provider and never inherits live
    // provider credentials such as TYPESAFE_API_KEY or OPENAI_API_KEY.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: options.homeDir,
      TMPDIR: options.homeDir,
      NO_COLOR: "1",
      SLIPMEM_DIR: options.root,
      XDG_CACHE_HOME: options.cacheDir,
      XDG_STATE_HOME: options.stateDir,
      SLIPMEM_AUTO_MEMORY: "on",
      // Canonical primary-chat names for the event-driven runtime. Recall uses
      // this same model unless Jev is explicitly selected.
      SLIPMEM_CHAT_PROVIDER: "openai-compatible",
      SLIPMEM_CHAT_BASE_URL: options.mockBaseUrl,
      SLIPMEM_CHAT_MODEL: model,
      SLIPMEM_CHAT_API_KEY: apiKey,
      // No SLIPMEM_RECALL_PROVIDER, no TYPESAFE_API_KEY, and no Jev model.
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const client = new StdioClient(proc)
  try {
    await client.initialize()
  } catch (error) {
    await client.close()
    throw new Error(
      `Runtime '${options.name}' failed to initialize: ${
        error instanceof Error ? error.message : String(error)
      }\nRuntime stderr:\n${client.stderr() || "(empty)"}`,
    )
  }
  return { client }
}

interface GeneratedSnapshot {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly contentHash: string
  readonly sourceIds: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly provenanceSource: string | undefined
  readonly provenanceActor: string | undefined
}

const scanGenerated = async (
  root: string,
  rawId: string,
): Promise<ReadonlyArray<GeneratedSnapshot>> => {
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({ root, now: () => Date.now() }),
  )
  const scan = await Effect.runPromise(repository.scan())
  return scan.notes
    .filter((note) => {
      if (note.metadata.type !== "permanent") {
        return false
      }
      const maintenance = asRecord(note.unknown.maintenance)
      if (maintenance === null) {
        return false
      }
      return (
        Array.isArray(maintenance.sources) &&
        maintenance.sources.some(
          (source) => asRecord(source)?.id === rawId,
        )
      )
    })
    .map((note) => {
      const maintenance = asRecord(note.unknown.maintenance)
      const sources = Array.isArray(maintenance?.sources)
        ? maintenance.sources
        : []
      return {
        id: note.id,
        title: note.metadata.title,
        body: note.body,
        contentHash: note.contentHash,
        sourceIds: sources
          .map((source) => asRecord(source)?.id)
          .filter((id): id is string => typeof id === "string"),
        tags: note.metadata.tags ?? [],
        provenanceSource: note.metadata.provenance?.source,
        provenanceActor: note.metadata.provenance?.actor,
      }
    })
}

const listPermanents = async (
  client: ToolClient,
): Promise<ReadonlyArray<JsonRecord>> => {
  const result = structured(
    await client.callTool("list_permanent_notes", { limit: 50 }),
  )
  return Array.isArray(result.notes)
    ? (result.notes as ReadonlyArray<JsonRecord>)
    : []
}

const getPermanent = async (
  client: ToolClient,
  id: string,
): Promise<JsonRecord> => {
  const result = structured(
    await client.callTool("get_permanent_note", { id }),
  )
  const note = asRecord(result.note)
  if (note === null) {
    throw new Error(`Permanent note not found through MCP: ${id}`)
  }
  return note
}

const getFleeting = async (
  client: ToolClient,
  id: string,
): Promise<JsonRecord> => {
  const result = structured(
    await client.callTool("get_fleeting_note", { id }),
  )
  const note = asRecord(result.note)
  if (note === null) {
    throw new Error(`Fleeting note not found through MCP: ${id}`)
  }
  return note
}

const waitFor = async <A>(
  label: string,
  probe: () => Promise<A | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}.${
      lastError === null
        ? ""
        : ` Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`
    }`,
  )
}

const pendingProposals = async (root: string): Promise<ReadonlyArray<string>> => {
  try {
    const names = await readdir(join(root, ".state", "pending"))
    return names.filter((name) => name.endsWith(".json")).sort()
  } catch {
    return []
  }
}

const rawContentHash = async (
  root: string,
  rawId: string,
): Promise<string | null> => {
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({ root, now: () => Date.now() }),
  )
  const scan = await Effect.runPromise(repository.scan())
  return scan.notes.find((note) => note.id === rawId)?.contentHash ?? null
}

const readRevisionReceipts = async (
  root: string,
): Promise<JsonRecord | null> => {
  try {
    return asRecord(
      JSON.parse(
        await readFile(
          join(root, ".state", "automatic-memory-revisions.json"),
          "utf8",
        ),
      ),
    )
  } catch {
    return null
  }
}

test(
  "offline runtime generates immediately, recalls through chat without Jev, and dedupes on restart",
  async () => {
    const nonce = crypto.randomUUID().slice(0, 8)
    const tempBase = existsSync("/tmp/opencode")
      ? "/tmp/opencode"
      : tmpdir()
    const base = await mkdtemp(
      join(tempBase, `slipmem-auto-memory-acceptance-${nonce}-`),
    )
    const root = join(base, ".slipmem")
    const homeDir = join(base, "home")
    const cacheDir = join(base, "cache")
    const stateDir = join(base, "state")

    const rawTitle = `Acceptance raw capture ${nonce}`
    const rawBody = `Raw fleeting note ${nonce}. Durable preference: use the loopback model for maintenance.`
    const generatedTitle = `Acceptance generated memory ${nonce}`
    const generatedContent = `Generated permanent ${nonce} from the raw capture through the loopback chat model.`
    const records: MockRecord[] = []

    await Effect.runPromise(initializeNoteRoot(root))

    const mock = startMockProvider({
      nonce,
      generatedTitle,
      generatedContent,
      records,
    })

    let rawId = ""
    let generatedId = ""

    try {
      // First process: one runtime instance with no periodic timer. Submitting
      // the raw note through the real MCP surface must wake maintenance and
      // produce the generated permanent in this same process.
      const first = await startRuntime({
        name: "generate-and-recall",
        root,
        cacheDir,
        stateDir,
        homeDir,
        mockBaseUrl: mock.baseUrl,
      })
      try {
        const created = await first.client.callTool("create_fleeting_note", {
          title: rawTitle,
          content: rawBody,
          tags: ["acceptance", "raw"],
        })
        expect(created.isError).not.toBe(true)
        const raw = structured(created)
        expect(raw.status).toBeUndefined()
        expect(raw.type).toBe("fleeting")
        expect(raw.title).toBe(rawTitle)
        expect(raw.content).toBe(rawBody)
        expect(typeof raw.id).toBe("string")
        rawId = raw.id as string
        expect(existsSync(join(root, `${rawId}.md`))).toBe(true)

        const generated = await waitFor(
          "raw-write-generated permanent",
          async () => {
            const permanents = await listPermanents(first.client)
            return permanents.length === 1 ? permanents[0] : null
          },
        )
        expect(typeof generated.id).toBe("string")
        generatedId = generated.id as string

        const detail = await getPermanent(first.client, generatedId)
        expect(detail.type).toBe("permanent")
        expect(detail.title).toBe(generatedTitle)
        expect(detail.content).toBe(generatedContent)

        const generatedNotes = await scanGenerated(root, rawId)
        expect(generatedNotes).toHaveLength(1)
        const stored = generatedNotes[0]!
        expect(stored.id).toBe(generatedId)
        expect(stored.title).toBe(generatedTitle)
        expect(stored.body).toBe(generatedContent)
        expect(stored.sourceIds).toEqual([rawId])
        expect(stored.tags).toEqual(["acceptance", "generated"])
        expect(stored.provenanceSource).toBe("maintenance")
        expect(stored.provenanceActor).toBe("slipmem-maintenance")

        // The maintenance request is exactly one tool-less chat-completions
        // request with the fixed offline key and the raw note as bounded input.
        const maintenanceRequests = records.filter(
          (request) => request.kind === "maintenance",
        )
        expect(maintenanceRequests).toHaveLength(1)
        const maintenance = maintenanceRequests[0]!
        expect(maintenance.path).toBe("/chat/completions")
        expect(maintenance.model).toBe(model)
        expect(maintenance.sourceIds).toEqual([rawId])
        expect(maintenance.prompt).toContain(rawBody)
        expect(maintenance.hasTools).toBe(false)
        expect(maintenance.authorization).toBe(`Bearer ${apiKey}`)

        // No Jev is configured. The same primary chat model is the recall
        // evaluator, so this must be a typed relevance decision rather than an
        // unconfigured/failed recall.
        const recall = await first.client.callTool("recall_prompt", {
          prompt: "Which durable preference applies to maintenance?",
        })
        expect(recall.isError).not.toBe(true)
        const report = structured(recall)
        expect(report.evaluator).toBe(model)
        expect(report.counts).toEqual({
          eligible: 1,
          relevant: 1,
          irrelevant: 0,
          failed: 0,
          skipped: 0,
        })
        expect(Array.isArray(report.notes)).toBe(true)
        const recallNotes = report.notes as ReadonlyArray<JsonRecord>
        expect(recallNotes).toHaveLength(1)
        expect(recallNotes[0]!.id).toBe(generatedId)
        expect(recallNotes[0]!.decision).toBe("relevant")
        expect(recallNotes[0]!.confidence).toBe(0.9)
        expect(report.failures).toEqual([])

        const recallRequests = records.filter(
          (request) => request.kind === "recall",
        )
        expect(recallRequests).toHaveLength(1)
        const recallRequest = recallRequests[0]!
        expect(recallRequest.path).toBe("/chat/completions")
        expect(recallRequest.model).toBe(model)
        expect(recallRequest.hasTools).toBe(false)
        expect(recallRequest.authorization).toBe(`Bearer ${apiKey}`)
        expect(recallRequest.userPrompt).toContain(generatedContent)
        expect(recallRequest.userPrompt).toContain(
          "Which durable preference applies to maintenance?",
        )

        // Recall is read-only: the generated note and maintenance write are
        // unchanged.
        const afterRecall = await getPermanent(first.client, generatedId)
        expect(afterRecall.content).toBe(generatedContent)
        expect(await scanGenerated(root, rawId)).toHaveLength(1)

        expect(records.filter((request) => request.kind === "maintenance")).toHaveLength(1)
      } finally {
        await first.client.close()
      }

      const beforeRestart = await scanGenerated(root, rawId)
      expect(beforeRestart).toHaveLength(1)
      const rawHash = await rawContentHash(root, rawId)
      expect(rawHash).not.toBeNull()

      const receipts = await waitFor("durable revision receipt", async () => {
        const value = await readRevisionReceipts(root)
        const revisions = asRecord(value?.revisions)
        return revisions?.[rawId] === rawHash ? value : null
      })
      expect(receipts.version).toBe(1)
      // Only revisions the worker actually examined are receipted; the marker
      // also invalidates whole-snapshot receipts from the earlier drain bug.
      expect(receipts.coverage).toBe("examined")

      // Second process: startup recovery sees an unchanged raw revision. The
      // durable receipt gate must make it a no-op, not a duplicate or rewrite,
      // and must not call the chat provider again.
      const second = await startRuntime({
        name: "restart",
        root,
        cacheDir,
        stateDir,
        homeDir,
        mockBaseUrl: mock.baseUrl,
      })
      try {
        // Startup recovery is enqueued while the server layer is built. A local
        // no-op completes before or shortly after initialize.
        await sleep(750)
        const afterRestart = await scanGenerated(root, rawId)
        expect(afterRestart).toEqual(beforeRestart)
        expect(afterRestart).toHaveLength(1)
        expect(afterRestart[0]!.id).toBe(generatedId)
        expect(afterRestart[0]!.contentHash).toBe(beforeRestart[0]!.contentHash)
        expect(records.filter((request) => request.kind === "maintenance")).toHaveLength(1)
        expect(records.filter((request) => request.kind === "recall")).toHaveLength(1)

        const listed = await listPermanents(second.client)
        expect(listed).toHaveLength(1)
        expect(listed[0]!.id).toBe(generatedId)

        // The raw source remains untouched and the generated write did not use
        // the human approval queue.
        const raw = await getFleeting(second.client, rawId)
        expect(raw.title).toBe(rawTitle)
        expect(raw.content).toBe(rawBody)
        expect(await pendingProposals(root)).toEqual([])

        // The generated note is still typed MCP content after restart.
        const detail = await getPermanent(second.client, generatedId)
        expect(detail.content).toBe(generatedContent)
      } finally {
        await second.client.close()
      }
    } finally {
      mock.server.stop(true)
      if (process.env.SLIPMEM_E2E_KEEP !== "1") {
        await rm(base, { recursive: true, force: true })
      }
    }
  },
  { timeout: 30_000 },
)
