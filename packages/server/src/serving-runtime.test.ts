import { initializeNoteRoot } from "@slipmem/core"
import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { HttpRouter } from "effect/http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeServingAppLayer, makeServingApiHandler } from "./serving-runtime"

const jsonRequest = (
  path: string,
  method: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })

const apiRequest = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { accept: "application/json" },
  })

const initializeMcp = async (handler: (request: Request) => Promise<Response>) => {
  const response = await handler(
    jsonRequest("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "slipmem-serving-runtime-test", version: "0.0.0" },
      },
    }),
  )
  expect(response.status).toBe(200)
  const sessionId = response.headers.get("mcp-session-id")
  expect(sessionId).toBeTruthy()
  await response.text()
  return sessionId!
}

const callTool = async (
  handler: (request: Request) => Promise<Response>,
  sessionId: string,
  id: number,
  name: string,
  args: unknown,
) => {
  const response = await handler(
    jsonRequest(
      "/mcp",
      "POST",
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
    ),
  )
  expect(response.status).toBe(200)
  return (await response.json()) as {
    readonly result: {
      readonly isError?: boolean
      readonly structuredContent?: unknown
    }
  }
}

test("JSON API and HTTP MCP share one serving graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-serving-runtime-"))
  const root = join(directory, ".slipmem")
  const cacheDir = join(directory, "cache")
  const now = () => Date.UTC(2026, 10, 17, 12, 0, 0)

  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const { layer } = makeServingAppLayer(root, {
      cacheDir,
      now,
      env: {},
      automaticMemory: { enabled: false },
    })
    const app = HttpRouter.toWebHandler(layer, { disableLogger: true })
    const handler = (request: Request) =>
      app.handler(request, Context.empty())

    try {
      const sessionId = await initializeMcp(handler)

      const created = await callTool(
        handler,
        sessionId,
        2,
        "create_fleeting_note",
        {
          title: "Shared graph",
          content: "Written through MCP.",
        },
      )
      expect(created.result.isError).toBeFalsy()
      const mcpNote = created.result.structuredContent as { id: string }

      // The JSON API observes the same repository instance, not a second
      // Markdown layer.
      const list = await handler(apiRequest("/api/notes"))
      expect(list.status).toBe(200)
      const listed = (await list.json()) as {
        readonly notes: ReadonlyArray<{ readonly id: string }>
      }
      expect(listed.notes.map((note) => note.id)).toContain(mcpNote.id)

      // A JSON API write is visible to MCP over the same repository.
      const apiWrite = await handler(
        jsonRequest("/api/notes", "POST", {
          type: "literature",
          title: "From the API",
          content: "Written through JSON.",
          reference: "https://example.com/shared-graph",
        }),
      )
      expect(apiWrite.status).toBe(201)
      const apiNote = (await apiWrite.json()) as {
        readonly note: { readonly id: string }
      }

      const mcpList = await callTool(
        handler,
        sessionId,
        3,
        "list_literature_notes",
        {},
      )
      const mcpNotes = mcpList.result.structuredContent as {
        readonly notes: ReadonlyArray<{ readonly id: string }>
      }
      expect(mcpNotes.notes.map((note) => note.id)).toContain(
        apiNote.note.id,
      )
    } finally {
      await app.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("the serving handler reports readiness and disposes its graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-serving-handler-"))
  const root = join(directory, ".slipmem")
  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const api = makeServingApiHandler(root, {
      cacheDir: join(directory, "cache"),
      env: {},
      automaticMemory: { enabled: false },
      disableLogger: true,
    })
    await api.ready
    const response = await api.handler(apiRequest("/api/health"))
    expect(response.status).toBe(200)
    const health = (await response.json()) as {
      readonly service: string
      readonly noteRoot: string
    }
    expect(health.service).toBe("slipmem")
    expect(health.noteRoot).toBe(root)
    await api.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a missing note root rejects the serving handler readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-serving-missing-"))
  const missingRoot = join(directory, "missing", ".slipmem")
  const api = makeServingApiHandler(missingRoot, {
    env: {},
    automaticMemory: { enabled: false },
    disableLogger: true,
  })
  try {
    await expect(api.ready).rejects.toThrow("slipmem init")
  } finally {
    await api.dispose().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
