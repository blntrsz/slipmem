import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeApiHandler } from "./app"

interface Note {
  readonly id: string
  readonly type: "fleeting" | "literature" | "permanent"
  readonly title: string
  readonly content: string
  readonly reference?: string
}

const jsonRequest = (
  path: string,
  method: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const readNotes = async (response: Response): Promise<ReadonlyArray<Note>> => {
  const body = (await response.json()) as { readonly notes: ReadonlyArray<Note> }
  return body.notes
}

test("JSON API creates, lists, updates, and deletes every note kind", async () => {
  const api = makeApiHandler(":memory:", { disableLogger: true })

  try {
    const fleetingResponse = await api.handler(
      jsonRequest("/api/notes/fleeting", "POST", {
        title: "Fleeting",
        content: "quick thought",
      }),
    )
    expect(fleetingResponse.status).toBe(201)
    const fleeting = (await fleetingResponse.json()) as Note
    expect(fleeting).toMatchObject({
      type: "fleeting",
      title: "Fleeting",
      content: "quick thought",
    })

    const literatureResponse = await api.handler(
      jsonRequest("/api/notes/literature", "POST", {
        title: "Literature",
        content: "a quote",
        reference: "Book, chapter 2",
      }),
    )
    expect(literatureResponse.status).toBe(201)
    const literature = (await literatureResponse.json()) as Note
    expect(literature).toMatchObject({
      type: "literature",
      title: "Literature",
      content: "a quote",
      reference: "Book, chapter 2",
    })

    const permanentResponse = await api.handler(
      jsonRequest("/api/notes/permanent", "POST", {
        title: "Permanent",
        content: "a lasting idea",
      }),
    )
    expect(permanentResponse.status).toBe(201)
    const permanent = (await permanentResponse.json()) as Note
    expect(permanent.type).toBe("permanent")

    const allResponse = await api.handler(
      new Request("http://localhost/api/notes"),
    )
    expect(allResponse.status).toBe(200)
    expect(await readNotes(allResponse)).toHaveLength(3)

    const fleetingListResponse = await api.handler(
      new Request("http://localhost/api/notes/fleeting"),
    )
    expect(await readNotes(fleetingListResponse)).toEqual([fleeting])

    const updateResponse = await api.handler(
      jsonRequest(`/api/notes/fleeting/${fleeting.id}`, "PUT", {
        title: "Updated",
        content: "changed",
      }),
    )
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toMatchObject({
      id: fleeting.id,
      title: "Updated",
      content: "changed",
    })

    const missingUpdateResponse = await api.handler(
      jsonRequest("/api/notes/fleeting/missing", "PUT", {
        title: "Missing",
        content: "missing",
      }),
    )
    expect(missingUpdateResponse.status).toBe(404)

    const deleteResponse = await api.handler(
      new Request(`http://localhost/api/notes/permanent/${permanent.id}`, {
        method: "DELETE",
      }),
    )
    expect(deleteResponse.status).toBe(200)
    expect(await deleteResponse.json()).toEqual({ deleted: true })

    const remainingResponse = await api.handler(
      new Request("http://localhost/api/notes"),
    )
    expect((await readNotes(remainingResponse)).map((note) => note.id)).not.toContain(
      permanent.id,
    )
  } finally {
    await api.dispose()
  }
})

test("JSON API rejects unknown note types and malformed bodies", async () => {
  const api = makeApiHandler(":memory:", { disableLogger: true })

  try {
    const unknownTypeResponse = await api.handler(
      new Request("http://localhost/api/notes/unknown"),
    )
    expect(unknownTypeResponse.status).toBe(400)

    const invalidBodyResponse = await api.handler(
      jsonRequest("/api/notes/fleeting", "POST", { title: "Missing content" }),
    )
    expect(invalidBodyResponse.status).toBe(400)

    const tooLongResponse = await api.handler(
      jsonRequest("/api/notes/fleeting", "POST", {
        title: "Too long",
        content: "a".repeat(1001),
      }),
    )
    expect(tooLongResponse.status).toBe(400)

    const missingReferenceResponse = await api.handler(
      jsonRequest("/api/notes/literature", "POST", {
        title: "No source",
        content: "a quote",
      }),
    )
    expect(missingReferenceResponse.status).toBe(400)

    const nonJsonResponse = await api.handler(
      jsonRequest(
        "/api/notes/fleeting",
        "POST",
        { title: "Not JSON", content: "body" },
        { "content-type": "text/plain" },
      ),
    )
    expect(nonJsonResponse.status).toBe(400)
  } finally {
    await api.dispose()
  }
})

test("notes persist across API handler restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-web-"))
  const databasePath = join(directory, "notes.db")

  try {
    const first = makeApiHandler(databasePath, { disableLogger: true })
    const created = (await (
      await first.handler(
        jsonRequest("/api/notes/literature", "POST", {
          title: "Persisted",
          content: "stays after restart",
          reference: "Notebook",
        }),
      )
    ).json()) as Note
    await first.dispose()

    const second = makeApiHandler(databasePath, { disableLogger: true })
    const notes = await readNotes(
      await second.handler(new Request("http://localhost/api/notes")),
    )
    await second.dispose()

    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      id: created.id,
      type: "literature",
      title: "Persisted",
      reference: "Notebook",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const initializeMcp = async (api: ReturnType<typeof makeApiHandler>) => {
  const response = await api.handler(
    jsonRequest(
      "/mcp",
      "POST",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "slipmem-test", version: "0.0.0" },
        },
      },
      { accept: "application/json, text/event-stream" },
    ),
  )

  expect(response.status).toBe(200)
  const sessionId = response.headers.get("mcp-session-id")
  expect(sessionId).toBeTruthy()
  expect(await response.text()).toContain("slipmem")

  return sessionId!
}

const mcpToolCall = (
  sessionId: string,
  id: number,
  name: string,
  args: unknown,
) =>
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
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
  )

test("MCP endpoint initializes over streamable HTTP", async () => {
  const api = makeApiHandler(":memory:", { disableLogger: true })

  try {
    await initializeMcp(api)
  } finally {
    await api.dispose()
  }
})

test("MCP tools over HTTP share the JSON API database", async () => {
  const api = makeApiHandler(":memory:", { disableLogger: true })

  try {
    const sessionId = await initializeMcp(api)

    const createdResponse = await api.handler(
      mcpToolCall(sessionId, 2, "create_permanent_note", {
        title: "From MCP",
        content: "same database",
      }),
    )
    expect(createdResponse.status).toBe(200)
    const createdBody = (await createdResponse.json()) as {
      readonly result: {
        readonly structuredContent: {
          readonly id: string
          readonly title: string
        }
      }
    }
    expect(createdBody.result.structuredContent).toMatchObject({
      title: "From MCP",
      content: "same database",
    })

    const notes = await readNotes(
      await api.handler(new Request("http://localhost/api/notes/permanent")),
    )
    expect(notes).toEqual([
      expect.objectContaining({
        id: createdBody.result.structuredContent.id,
        type: "permanent",
        title: "From MCP",
      }),
    ])
  } finally {
    await api.dispose()
  }
})
