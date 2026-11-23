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

const apiRequest = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { accept: "application/json" },
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
      // A programmatic host may inject the disabled fixture runtime instead of
      // resolving the required serving chat model from the environment.
      extraRoutes: makeMcpHttp({
        root,
        cacheDir,
        now,
        env: { SLIPMEM_ACTOR: "http-agent" },
        automaticMemory: { enabled: false },
      }),
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
        "list_tags",
        "build_tag_wiki",
        "recall_prompt",
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
        tags: ["Agent Memory"],
      })
      expect(permanent.result.isError).toBeFalsy()
      expect(permanent.result.structuredContent).toEqual(
        expect.objectContaining({ status: "pending_approval" }),
      )
      const proposal = permanent.result.structuredContent as {
        readonly proposalId: string
      }
      expect(proposal.proposalId).toMatch(/^proposal-\d{14}-[0-9a-f]{8}$/)

      const pendingBefore = await readdir(join(root, ".state", "pending"))
      expect(pendingBefore.filter((name) => name.endsWith(".json"))).toHaveLength(1)
      const noteFilesBefore = (await readdir(root)).filter(
        (name) => name.endsWith(".md") && name !== "README.md",
      )
      expect(noteFilesBefore).toEqual(["http-source.md"])

      const list = await callTool(api, sessionId, 5, "list_permanent_notes", {})
      expect(
        (list.result.structuredContent as { notes: ReadonlyArray<unknown> }).notes,
      ).toEqual([])

      const pendingResponse = await api.handler(apiRequest("/api/pending"))
      expect(pendingResponse.status).toBe(200)
      const review = (await pendingResponse.json()) as {
        readonly proposals: ReadonlyArray<{
          readonly id: string
          readonly operation: string
          readonly actor?: string
          readonly summary: string
          readonly stale: boolean
          readonly expired: boolean
          readonly diff: string
        }>
      }
      expect(review.proposals).toHaveLength(1)
      expect(review.proposals[0]).toMatchObject({
        id: proposal.proposalId,
        operation: "create",
        actor: "http-agent",
        stale: false,
        expired: false,
      })
      expect(review.proposals[0]!.summary).toContain("Create permanent note")
      expect(review.proposals[0]!.diff).toContain("+No file yet.")

      const approveResponse = await api.handler(
        apiRequest(`/api/pending/${proposal.proposalId}/approve`, "POST"),
      )
      expect(approveResponse.status).toBe(200)
      const approved = (await approveResponse.json()) as {
        readonly status: string
        readonly proposalId: string
        readonly operation: string
        readonly noteId: string
        readonly note: {
          readonly type: string
          readonly title: string
          readonly content: string
          readonly tags: ReadonlyArray<string>
          readonly provenance?: {
            readonly source?: string
            readonly actor?: string
          }
        }
        readonly index: { readonly status: string }
      }
      expect(approved).toMatchObject({
        status: "applied",
        proposalId: proposal.proposalId,
        operation: "create",
      })
      expect(approved.note).toMatchObject({
        type: "permanent",
        title: "Needs approval",
        content: "No file yet.",
        tags: ["agent-memory"],
        provenance: { source: "mcp", actor: "http-agent" },
      })
      expect(approved.index).toEqual({ status: "refreshed" })

      const pendingAfter = await readdir(join(root, ".state", "pending"))
      expect(pendingAfter.filter((name) => name.endsWith(".json"))).toHaveLength(0)
      expect(
        (await readdir(root)).filter(
          (name) => name.endsWith(".md") && name !== "README.md",
        ),
      ).toHaveLength(2)

      const visible = await callTool(api, sessionId, 6, "list_permanent_notes", {})
      expect(
        (visible.result.structuredContent as { notes: ReadonlyArray<unknown> }).notes,
      ).toEqual([
        expect.objectContaining({
          id: approved.noteId,
          type: "permanent",
          title: "Needs approval",
        }),
      ])

      const fetched = await callTool(api, sessionId, 7, "get_permanent_note", {
        id: approved.noteId,
      })
      expect(fetched.result.isError).toBeFalsy()
      expect(fetched.result.structuredContent).toEqual({
        note: expect.objectContaining({
          id: approved.noteId,
          type: "permanent",
          title: "Needs approval",
          content: "No file yet.",
        }),
      })

      const afterReviewResponse = await api.handler(apiRequest("/api/pending"))
      const afterReview = (await afterReviewResponse.json()) as {
        readonly proposals: ReadonlyArray<unknown>
      }
      expect(afterReview.proposals).toHaveLength(0)

      const search = await callTool(api, sessionId, 8, "search_notes", {
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
}, 30_000)
