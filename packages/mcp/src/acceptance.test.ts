import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "../../..")

const expectedToolNames = [
  "list_fleeting_notes",
  "get_fleeting_note",
  "create_fleeting_note",
  "update_fleeting_note",
  "delete_fleeting_note",
  "list_permanent_notes",
  "get_permanent_note",
  "create_permanent_note",
  "update_permanent_note",
  "delete_permanent_note",
  "list_literature_notes",
  "get_literature_note",
  "create_literature_note",
  "update_literature_note",
  "delete_literature_note",
]

interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface ToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: string }
  >
  readonly structuredContent?: unknown
}

interface Note {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly reference?: string
}

const withTemporaryDirectory = async <A>(
  run: (directory: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-acceptance-"))

  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * A minimal process-level MCP client.
 *
 * It deliberately uses the real NDJSON framing instead of effect's in-memory
 * test client, so the acceptance test covers argument parsing, stdin/stdout,
 * startup, and shutdown as an MCP host sees them.
 */
const startServer = (databasePath: string) => {
  const server = Bun.spawn([process.execPath, "packages/mcp/src/main.ts"], {
    cwd: repositoryRoot,
    env: { ...process.env, SLIPMEM_DB_PATH: databasePath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const decoder = new TextDecoder()
  const pending = new Map<
    number,
    {
      readonly resolve: (response: JsonRpcResponse) => void
      readonly reject: (error: Error) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >()
  const reader = server.stdout.getReader()
  const lines: Array<string> = []
  let buffer = ""

  const settle = (response: JsonRpcResponse) => {
    if (typeof response.id !== "number") return
    const waiter = pending.get(response.id)
    if (waiter === undefined) return

    clearTimeout(waiter.timer)
    pending.delete(response.id)
    waiter.resolve(response)
  }

  const pump = async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return

      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length > 0) {
          lines.push(line)
          settle(JSON.parse(line) as JsonRpcResponse)
        }
        newline = buffer.indexOf("\n")
      }
    }
  }

  const pumping = pump()

  const request = (
    id: number,
    method: string,
    params?: unknown,
    timeoutMs = 10_000,
  ): Promise<JsonRpcResponse> =>
    new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(
          new Error(
            `MCP request timed out: ${method} (id ${id}). stdout so far:\n${lines.join("\n")}`,
          ),
        )
      }, timeoutMs)

      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      )
    })

  const notify = (method: string, params?: unknown) => {
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    )
  }

  const initialize = async () => {
    const response = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "slipmem-acceptance-test", version: "0.0.0" },
    })

    if (response.error !== undefined) {
      throw new Error(`initialize failed: ${JSON.stringify(response.error)}`)
    }

    notify("notifications/initialized")
    return response.result as {
      readonly protocolVersion: string
      readonly serverInfo: { readonly name: string; readonly version: string }
      readonly instructions?: string
    }
  }

  const callTool = async (id: number, name: string, args: unknown) => {
    const response = await request(id, "tools/call", {
      name,
      arguments: args,
    })

    if (response.error !== undefined) {
      throw new Error(
        `${name} returned a JSON-RPC error: ${JSON.stringify(response.error)}`,
      )
    }

    return response.result as ToolResult
  }

  const close = async () => {
    server.kill("SIGTERM")
    const exitCode = await server.exited
    await pumping
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("MCP server closed before the request completed"))
    }
    pending.clear()

    return {
      exitCode,
      stderr: await new Response(server.stderr).text(),
      lines: [...lines],
    }
  }

  return { initialize, request, callTool, close }
}

test("stdio MCP handshake exposes every note tool over NDJSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const client = startServer(join(directory, "notes.db"))

    try {
      const initialized = await client.initialize()
      expect(initialized.protocolVersion).toBe("2025-11-25")
      expect(initialized.serverInfo).toEqual({ name: "slipmem", version: "0.0.0" })
      expect(initialized.instructions).toContain("Literature notes")

      const response = await client.request(2, "tools/list", {})
      expect(response.error).toBeUndefined()
      const tools = (
        response.result as {
          readonly tools: ReadonlyArray<{
            readonly name: string
            readonly annotations?: Readonly<Record<string, boolean>>
          }>
        }
      ).tools

      expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames)

      const listFleeting = tools.find((tool) => tool.name === "list_fleeting_notes")
      expect(listFleeting?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      })

      const deleteFleeting = tools.find((tool) => tool.name === "delete_fleeting_note")
      expect(deleteFleeting?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      })
    } finally {
      const closed = await client.close()
      expect(closed.exitCode).toBe(0)
      expect(closed.stderr).toBe("")
      // Every stdout line must be one JSON-RPC message. A log line here would
      // corrupt the transport for real MCP hosts.
      for (const line of closed.lines) {
        expect(() => JSON.parse(line)).not.toThrow()
        expect((JSON.parse(line) as JsonRpcResponse).jsonrpc).toBe("2.0")
      }
    }
  })
})

test("stdio MCP CRUD persists across process restarts", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")

    const created = await (async () => {
      const client = startServer(databasePath)

      try {
        await client.initialize()

        const fleeting = await client.callTool(2, "create_fleeting_note", {
          title: "Fleeting from stdio",
          content: "written by the first process",
        })
        expect(fleeting.isError).toBeFalsy()
        const fleetingNote = fleeting.structuredContent as Note
        expect(fleetingNote.title).toBe("Fleeting from stdio")

        const permanent = await client.callTool(3, "create_permanent_note", {
          title: "Permanent from stdio",
          content: "still here after restart",
        })
        expect(permanent.isError).toBeFalsy()

        const literature = await client.callTool(4, "create_literature_note", {
          title: "Literature from stdio",
          content: "a quote",
          reference: "Book, chapter 1",
        })
        expect(literature.isError).toBeFalsy()
        expect(literature.structuredContent).toMatchObject({
          reference: "Book, chapter 1",
        })

        const updated = await client.callTool(5, "update_fleeting_note", {
          id: fleetingNote.id,
          title: "Fleeting updated",
          content: "changed by the first process",
        })
        expect(updated.structuredContent).toMatchObject({
          id: fleetingNote.id,
          title: "Fleeting updated",
        })

        return fleetingNote.id
      } finally {
        const closed = await client.close()
        expect(closed.exitCode).toBe(0)
        expect(closed.stderr).toBe("")
      }
    })()

    const client = startServer(databasePath)

    try {
      await client.initialize()

      const fleeting = await client.callTool(2, "list_fleeting_notes", {})
      expect(fleeting.structuredContent).toEqual({
        notes: [
          expect.objectContaining({
            id: created,
            title: "Fleeting updated",
          }),
        ],
      })

      const permanent = await client.callTool(3, "list_permanent_notes", {})
      expect(permanent.structuredContent).toEqual({
        notes: [expect.objectContaining({ title: "Permanent from stdio" })],
      })

      const literature = await client.callTool(4, "list_literature_notes", {})
      expect(literature.structuredContent).toEqual({
        notes: [expect.objectContaining({ reference: "Book, chapter 1" })],
      })

      const deleted = await client.callTool(5, "delete_fleeting_note", {
        id: created,
      })
      expect(deleted.structuredContent).toEqual({ deleted: true })

      const missing = await client.callTool(6, "get_fleeting_note", {
        id: created,
      })
      expect(missing.structuredContent).toEqual({ note: null })
    } finally {
      const closed = await client.close()
      expect(closed.exitCode).toBe(0)
      expect(closed.stderr).toBe("")
    }

    const db = new Database(databasePath)
    try {
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM __drizzle_migrations",
          )
          .get()!.count,
      ).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
    }
  })
})

test("stdio MCP returns declared failures and schema errors as tool errors", async () => {
  await withTemporaryDirectory(async (directory) => {
    const client = startServer(join(directory, "notes.db"))

    try {
      await client.initialize()

      const missing = await client.callTool(2, "update_fleeting_note", {
        id: "missing",
        title: "Nope",
        content: "Nope",
      })
      expect(missing.isError).toBe(true)
      expect(missing.content[0]).toMatchObject({ type: "text" })
      expect((missing.content[0] as { text: string }).text).toContain(
        "Fleeting note not found: missing",
      )

      const oversized = await client.callTool(3, "create_fleeting_note", {
        title: "Too long",
        content: "a".repeat(1001),
      })
      expect(oversized.isError).toBe(true)
      expect(
        oversized.content
          .map((content) => ("text" in content ? content.text : ""))
          .join(" "),
      ).toContain("1000")
    } finally {
      const closed = await client.close()
      expect(closed.exitCode).toBe(0)
      expect(closed.stderr).toBe("")
    }
  })
})
