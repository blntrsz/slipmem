import { initializeNoteRoot } from "@slipmem/core"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeApiHandler } from "./app"
import { makeMcpHttp } from "./mcp"

const jsonRequest = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })

const initializeMcp = async (api: ReturnType<typeof makeApiHandler>) => {
  const response = await api.handler(
    jsonRequest("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "slipmem-mcp-http-test", version: "0.0.0" },
      },
    }),
  )
  expect(response.status).toBe(200)
  const sessionId = response.headers.get("mcp-session-id")
  expect(sessionId).toBeTruthy()
  expect(await response.text()).toContain("slipmem")
  return sessionId!
}

const callTool = async (
  api: ReturnType<typeof makeApiHandler>,
  sessionId: string,
  id: number,
  name: string,
  args: unknown,
) => {
  const response = await api.handler(
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
      readonly content?: ReadonlyArray<{ readonly text?: string }>
    }
  }
}

const listTools = async (
  api: ReturnType<typeof makeApiHandler>,
  sessionId: string,
) => {
  const response = await api.handler(
    jsonRequest(
      "/mcp",
      "POST",
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
    ),
  )
  const body = (await response.json()) as {
    readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> }
  }
  return body.result.tools.map((tool) => tool.name)
}

test("HTTP MCP uses the same Markdown registrations and approval policy as stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-http-"))
  const root = join(directory, ".slipmem")
  const cacheDir = join(directory, "cache")
  const now = () => Date.UTC(2026, 10, 17, 12, 0, 0)

  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const api = makeApiHandler(root, {
      disableLogger: true,
      cacheDir,
      now,
      extraRoutes: makeMcpHttp({ root, cacheDir, now }),
    })

    try {
      const sessionId = await initializeMcp(api)
      const tools = await listTools(api, sessionId)
      expect(tools).toEqual([
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
        "search_notes",
        "list_topics",
        "build_topic_wiki",
      ])
      expect(tools.some((name) => /approve|reject|apply/.test(name))).toBe(false)

      const literature = await callTool(api, sessionId, 3, "create_literature_note", {
        title: "HTTP source",
        content: "Direct over HTTP.",
        reference: "https://example.com/http",
      })
      expect(literature.result.isError).toBeFalsy()
      expect(literature.result.structuredContent).toEqual(
        expect.objectContaining({
          type: "literature",
          title: "HTTP source",
          reference: "https://example.com/http",
        }),
      )

      const permanent = await callTool(api, sessionId, 4, "create_permanent_note", {
        title: "Needs approval",
        content: "No file yet.",
      })
      expect(permanent.result.isError).toBeFalsy()
      expect(permanent.result.structuredContent).toEqual(
        expect.objectContaining({ status: "pending_approval" }),
      )

      const pending = await readdir(join(root, ".state", "pending"))
      expect(pending.filter((name) => name.endsWith(".json"))).toHaveLength(1)

      const list = await callTool(api, sessionId, 5, "list_permanent_notes", {})
      expect(
        (list.result.structuredContent as { notes: ReadonlyArray<unknown> }).notes,
      ).toEqual([])

      const search = await callTool(api, sessionId, 6, "search_notes", {
        query: "HTTP",
        type: "literature",
      })
      expect(
        (search.result.structuredContent as { notes: ReadonlyArray<unknown> }).notes,
      ).toEqual([
        expect.objectContaining({
          id: (literature.result.structuredContent as { id: string }).id,
          title: "HTTP source",
        }),
      ])
    } finally {
      await api.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
