import { expect, test } from "bun:test"
import {
  initializeNoteRoot,
  makeMarkdownNoteRepository,
} from "@slipmem/core"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeApiHandler } from "./app"

interface ApiNoteResponse {
  readonly id: string
  readonly type: "fleeting" | "literature" | "permanent"
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly topics: ReadonlyArray<string>
  readonly path: string
  readonly createdAt: number
  readonly updatedAt: number
}

const ORIGIN = "http://127.0.0.1:3000"

const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

interface TestRoot {
  readonly directory: string
  readonly root: string
  readonly cacheDir: string
}

const makeRoot = async (): Promise<TestRoot> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-api-"))
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  return { directory, root, cacheDir: join(directory, "cache") }
}

const withApi = async <A>(
  run: (api: ReturnType<typeof makeApiHandler>, root: TestRoot) => Promise<A>,
): Promise<A> => {
  const root = await makeRoot()
  const api = makeApiHandler(root.root, {
    cacheDir: root.cacheDir,
    disableLogger: true,
  })
  try {
    return await run(api, root)
  } finally {
    await api.dispose()
    await rm(root.directory, { recursive: true, force: true })
  }
}

const readNote = async (response: Response): Promise<ApiNoteResponse> => {
  const body = (await response.json()) as { readonly note: ApiNoteResponse }
  return body.note
}

const readNotes = async (response: Response): Promise<ReadonlyArray<ApiNoteResponse>> => {
  const body = (await response.json()) as {
    readonly notes: ReadonlyArray<ApiNoteResponse>
  }
  return body.notes
}

test("health reports the Markdown note root and index mode", async () => {
  await withApi(async (api, root) => {
    const response = await api.handler(request("/api/health"))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly ok: boolean
      readonly noteRoot: string
      readonly index: { readonly mode: string }
    }
    expect(body.ok).toBe(true)
    expect(body.noteRoot).toBe(root.root)
    expect(["fts5", "linear"]).toContain(body.index.mode)
  })
})

test("canonical ID routes create, read, update, list, and delete flat Markdown notes", async () => {
  await withApi(async (api, root) => {
    const createdResponse = await api.handler(
      request("/api/notes", "POST", {
        type: "fleeting",
        title: "Quick thought",
        content: "Capture it before it disappears.",
        topics: ["Agent Memory"],
      }),
    )
    expect(createdResponse.status).toBe(201)
    const created = await readNote(createdResponse)
    expect(created).toMatchObject({
      type: "fleeting",
      title: "Quick thought",
      content: "Capture it before it disappears.",
      topics: ["agent-memory"],
    })
    expect(created.id).toMatch(/^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*$/)

    // The only file is a direct child of the note root; there is no type
    // directory or hidden content database.
    const entries = await readdir(root.root)
    expect(entries).toContain(`${created.id}.md`)
    expect(entries).not.toContain("fleeting")

    const getResponse = await api.handler(request(`/api/notes/${created.id}`))
    expect(getResponse.status).toBe(200)
    expect(await readNote(getResponse)).toMatchObject({
      id: created.id,
      title: "Quick thought",
    })

    const updatedResponse = await api.handler(
      request(`/api/notes/${created.id}`, "PUT", {
        title: "Updated thought",
        content: "Changed safely.",
      }),
    )
    expect(updatedResponse.status).toBe(200)
    const updated = await readNote(updatedResponse)
    expect(updated).toMatchObject({
      id: created.id,
      type: "fleeting",
      title: "Updated thought",
      content: "Changed safely.",
    })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    const listResponse = await api.handler(request("/api/notes?type=fleeting&limit=5"))
    expect(listResponse.status).toBe(200)
    expect(await readNotes(listResponse)).toHaveLength(1)

    const deleteResponse = await api.handler(
      request(`/api/notes/${created.id}`, "DELETE"),
    )
    expect(deleteResponse.status).toBe(200)
    const deleted = (await deleteResponse.json()) as {
      readonly deleted: boolean
      readonly backupPath: string
    }
    expect(deleted.deleted).toBe(true)
    expect(deleted.backupPath.startsWith(root.root)).toBe(false)
    expect(existsSync(join(root.root, `${created.id}.md`))).toBe(false)

    const afterDelete = await api.handler(request(`/api/notes/${created.id}`))
    expect(afterDelete.status).toBe(404)
  })
})

test("legacy type routes are thin adapters over the same ID repository", async () => {
  await withApi(async (api) => {
    const createdResponse = await api.handler(
      request("/api/notes/permanent", "POST", {
        title: "A durable idea",
        content: "Write it down properly.",
      }),
    )
    expect(createdResponse.status).toBe(201)
    const created = await readNote(createdResponse)
    expect(created.type).toBe("permanent")

    const listResponse = await api.handler(request("/api/notes/permanent"))
    expect(await readNotes(listResponse)).toEqual([
      expect.objectContaining({ id: created.id }),
    ])

    const getResponse = await api.handler(
      request(`/api/notes/permanent/${created.id}`),
    )
    expect(await readNote(getResponse)).toMatchObject({ id: created.id })

    const wrongTypeResponse = await api.handler(
      request(`/api/notes/fleeting/${created.id}`),
    )
    expect(wrongTypeResponse.status).toBe(404)

    const updateResponse = await api.handler(
      request(`/api/notes/permanent/${created.id}`, "PUT", {
        title: "Still a durable idea",
        content: "Reconsidered.",
      }),
    )
    expect(updateResponse.status).toBe(200)
    expect(await readNote(updateResponse)).toMatchObject({
      id: created.id,
      type: "permanent",
      title: "Still a durable idea",
    })

    const deleteResponse = await api.handler(
      request(`/api/notes/permanent/${created.id}`, "DELETE"),
    )
    expect(deleteResponse.status).toBe(200)

    const canonicalStillGone = await api.handler(
      request(`/api/notes/${created.id}`),
    )
    expect(canonicalStillGone.status).toBe(404)
  })
})

test("canonical writes enforce type, content, reference, id, and limit rules", async () => {
  await withApi(async (api) => {
    const unknownType = await api.handler(
      request("/api/notes", "POST", {
        type: "scoped",
        title: "Nope",
        content: "Nope",
      }),
    )
    expect(unknownType.status).toBe(400)

    const missingTitle = await api.handler(
      request("/api/notes", "POST", { type: "fleeting", content: "body" }),
    )
    expect(missingTitle.status).toBe(400)

    const missingReference = await api.handler(
      request("/api/notes", "POST", {
        type: "literature",
        title: "No source",
        content: "A quote",
      }),
    )
    expect(missingReference.status).toBe(400)
    expect(((await missingReference.json()) as { code: string }).code).toBe(
      "missing-reference",
    )

    const tooLong = await api.handler(
      request("/api/notes", "POST", {
        type: "fleeting",
        title: "Too long",
        content: "a".repeat(1001),
      }),
    )
    expect(tooLong.status).toBe(400)
    expect(((await tooLong.json()) as { code: string }).code).toBe(
      "content-too-long",
    )

    const traversal = await api.handler(
      request("/api/notes/..%2F..%2Fetc%2Fpasswd"),
    )
    expect(traversal.status).toBe(400)

    const badLimit = await api.handler(request("/api/notes?limit=all"))
    expect(badLimit.status).toBe(400)

    const emptySearch = await api.handler(request("/api/search"))
    expect(emptySearch.status).toBe(400)
  })
})

test("search and topics refresh the disposable index and stay bounded", async () => {
  await withApi(async (api) => {
    const created = await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title: "Bounded recall",
        content: "Every recall operation has a hard maximum.",
        topics: ["retrieval", "agent-memory"],
      }),
    )
    expect(created.status).toBe(201)
    const note = await readNote(created)

    const searchResponse = await api.handler(
      request("/api/search?q=recall&limit=3"),
    )
    expect(searchResponse.status).toBe(200)
    const searchBody = (await searchResponse.json()) as {
      readonly results: ReadonlyArray<{
        readonly id: string
        readonly note: { readonly title: string }
      }>
    }
    expect(searchBody.results).toHaveLength(1)
    expect(searchBody.results[0]).toMatchObject({
      id: note.id,
      note: { title: "Bounded recall" },
    })

    const filtered = await api.handler(
      request("/api/search?q=recall&type=literature"),
    )
    expect(
      ((await filtered.json()) as { readonly results: ReadonlyArray<unknown> })
        .results,
    ).toHaveLength(0)

    const topicsResponse = await api.handler(request("/api/topics?limit=10"))
    expect(topicsResponse.status).toBe(200)
    const topics = (await topicsResponse.json()) as {
      readonly topics: ReadonlyArray<{ topic: string; noteCount: number }>
    }
    expect(topics.topics).toEqual([
      { topic: "agent-memory", noteCount: 1 },
      { topic: "retrieval", noteCount: 1 },
    ])
  })
})

test("mutations are same-origin only and reject non-JSON bodies", async () => {
  await withApi(async (api) => {
    const crossOrigin = await api.handler(
      request(
        "/api/notes",
        "POST",
        { type: "fleeting", title: "Cross", content: "origin" },
        { origin: "https://evil.example" },
      ),
    )
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull()

    const crossSite = await api.handler(
      request(
        "/api/notes",
        "POST",
        { type: "fleeting", title: "Cross", content: "site" },
        { "sec-fetch-site": "cross-site" },
      ),
    )
    expect(crossSite.status).toBe(403)

    const plainText = await api.handler(
      request(
        "/api/notes",
        "POST",
        { type: "fleeting", title: "Plain", content: "text" },
        { "content-type": "text/plain" },
      ),
    )
    expect(plainText.status).toBe(415)

    const sameOrigin = await api.handler(
      request(
        "/api/notes",
        "POST",
        { type: "fleeting", title: "Same origin", content: "allowed" },
        { origin: ORIGIN },
      ),
    )
    expect(sameOrigin.status).toBe(201)

    const deleteCrossOrigin = await api.handler(
      request(
        `/api/notes/${(await readNote(sameOrigin)).id}`,
        "DELETE",
        undefined,
        { origin: "https://evil.example" },
      ),
    )
    expect(deleteCrossOrigin.status).toBe(403)
  })
})

test("files written by another surface are visible without restart", async () => {
  await withApi(async (api, root) => {
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({
        root: root.root,
        now: () => Date.UTC(2026, 10, 17, 20, 0, 0),
      }),
    )
    const external = await Effect.runPromise(
      repository.create({
        type: "literature",
        title: "External capture",
        content: "Written outside the HTTP process.",
        reference: "Notebook, page 4",
        topics: ["external"],
      }),
    )

    const listResponse = await api.handler(request("/api/notes"))
    expect(await readNotes(listResponse)).toEqual([
      expect.objectContaining({
        id: external.id,
        title: "External capture",
        reference: "Notebook, page 4",
      }),
    ])

    const searchResponse = await api.handler(
      request("/api/search?q=outside"),
    )
    const results = (await searchResponse.json()) as {
      readonly results: ReadonlyArray<{ readonly id: string }>
    }
    expect(results.results.map((result) => result.id)).toContain(external.id)
  })
})

test("a second handler over the same root sees the same notes", async () => {
  const root = await makeRoot()
  try {
    const first = makeApiHandler(root.root, {
      cacheDir: root.cacheDir,
      disableLogger: true,
    })
    const created = await readNote(
      await first.handler(
        request("/api/notes", "POST", {
          type: "permanent",
          title: "Persisted",
          content: "Survives a process restart.",
        }),
      ),
    )
    await first.dispose()

    const second = makeApiHandler(root.root, {
      cacheDir: root.cacheDir,
      disableLogger: true,
    })
    try {
      const notes = await readNotes(
        await second.handler(request("/api/notes")),
      )
      expect(notes).toEqual([
        expect.objectContaining({ id: created.id, title: "Persisted" }),
      ])
    } finally {
      await second.dispose()
    }
  } finally {
    await rm(root.directory, { recursive: true, force: true })
  }
})
