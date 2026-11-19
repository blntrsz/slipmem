import { expect, test } from "bun:test"
import {
  checkNoteRoot,
  initializeNoteRoot,
  makeApprovalService,
  makeMarkdownNoteRepository,
  makeMarkdownSearchIndex,
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
  readonly tags: ReadonlyArray<string>
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

test("health refreshes the index and reports synthesis capability", async () => {
  await withApi(async (api, root) => {
    const response = await api.handler(request("/api/health"))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly ok: boolean
      readonly noteRoot: string
      readonly index: { readonly mode: string; readonly noteCount: number }
      readonly wiki: {
        readonly synthesis: {
          readonly configured: boolean
          readonly kind: string
          readonly detail: string
        }
      }
    }
    expect(body.ok).toBe(true)
    expect(body.noteRoot).toBe(root.root)
    expect(["fts5", "linear"]).toContain(body.index.mode)
    expect(body.index.noteCount).toBe(0)
    expect(body.wiki.synthesis.configured).toBe(false)
    expect(body.wiki.synthesis.detail.length).toBeGreaterThan(0)

    // A note written by another surface is counted without a search or a
    // restart: health refreshes the disposable index before reading it.
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({ root: root.root }),
    )
    await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: "External before health",
        content: "Written after the first health request.",
      }),
    )

    const refreshed = await api.handler(request("/api/health"))
    const refreshedBody = (await refreshed.json()) as {
      readonly index: { readonly noteCount: number }
    }
    expect(refreshedBody.index.noteCount).toBe(1)
  })
})

test("canonical ID routes create, read, update, list, and delete flat Markdown notes", async () => {
  await withApi(async (api, root) => {
    const createdResponse = await api.handler(
      request("/api/notes", "POST", {
        type: "fleeting",
        title: "Quick thought",
        content: "Capture it before it disappears.",
        tags: ["Agent Memory"],
      }),
    )
    expect(createdResponse.status).toBe(201)
    const created = await readNote(createdResponse)
    expect(created).toMatchObject({
      type: "fleeting",
      title: "Quick thought",
      content: "Capture it before it disappears.",
      tags: ["agent-memory"],
    })
    expect(created.id).toBe("quick-thought")

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

test("writes reject the legacy topics field instead of silently dropping tags", async () => {
  await withApi(async (api) => {
    const create = await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title: "Legacy write",
        content: "Must not lose metadata.",
        topics: ["legacy"],
      }),
    )
    expect(create.status).toBe(400)
    const createBody = (await create.json()) as {
      readonly code: string
      readonly error: string
    }
    expect(createBody.code).toBe("invalid-field")
    expect(createBody.error).toContain("tags")
    expect(createBody.error).toContain("legacy `topics` frontmatter")

    const notes = await api.handler(request("/api/notes"))
    expect(await readNotes(notes)).toEqual([])

    const created = await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title: "Canonical write",
        content: "Tags stay intact.",
        tags: ["agent-memory"],
      }),
    )
    expect(created.status).toBe(201)
    const note = await readNote(created)

    const update = await api.handler(
      request(`/api/notes/${note.id}`, "PUT", {
        topics: ["legacy"],
      }),
    )
    expect(update.status).toBe(400)
    const updateBody = (await update.json()) as {
      readonly code: string
      readonly error: string
    }
    expect(updateBody.code).toBe("invalid-field")
    expect(updateBody.error).toContain("tags")

    const reread = await api.handler(request(`/api/notes/${note.id}`))
    expect((await readNote(reread)).tags).toEqual(["agent-memory"])
  })
})

test("search and tags refresh the disposable index and stay bounded", async () => {
  await withApi(async (api) => {
    const created = await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title: "Bounded recall",
        content: "Every recall operation has a hard maximum.",
        tags: ["retrieval", "agent-memory"],
      }),
    )
    expect(created.status).toBe(201)
    const note = await readNote(created)

    const fleetingResponse = await api.handler(
      request("/api/notes", "POST", {
        type: "fleeting",
        title: "Fleeting recall",
        content: "A quick recall thought.",
        tags: ["agent-memory"],
      }),
    )
    expect(fleetingResponse.status).toBe(201)
    const fleeting = await readNote(fleetingResponse)

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
    expect(searchBody.results).toHaveLength(2)
    expect(searchBody.results.map((result) => result.id)).toContain(note.id)
    expect(searchBody.results.map((result) => result.id)).toContain(fleeting.id)

    const filtered = await api.handler(
      request("/api/search?q=recall&type=literature"),
    )
    expect(
      ((await filtered.json()) as { readonly results: ReadonlyArray<unknown> })
        .results,
    ).toHaveLength(0)

    const tagsResponse = await api.handler(request("/api/tags?limit=10"))
    expect(tagsResponse.status).toBe(200)
    const tags = (await tagsResponse.json()) as {
      readonly tags: ReadonlyArray<{
        tag: string
        noteCount: number
        byType: { fleeting: number; literature: number; permanent: number }
      }>
    }
    expect(tags.tags).toEqual([
      {
        tag: "agent-memory",
        noteCount: 2,
        byType: { fleeting: 1, literature: 0, permanent: 1 },
      },
      {
        tag: "retrieval",
        noteCount: 1,
        byType: { fleeting: 0, literature: 0, permanent: 1 },
      },
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
        tags: ["external"],
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

test("wiki pages are cited, derived, and available as structured JSON or Markdown", async () => {
  await withApi(async (api, root) => {
    const created = await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title: "Bounded recall",
        content: "Every list, search, and recall operation has a hard maximum.",
        tags: ["agent-memory"],
      }),
    )
    const note = await readNote(created)

    const fleetingResponse = await api.handler(
      request("/api/notes", "POST", {
        type: "fleeting",
        title: "Fleeting recall note",
        content: "A fleeting idea about agent memory.",
        tags: ["agent-memory"],
      }),
    )
    expect(fleetingResponse.status).toBe(201)
    const fleeting = await readNote(fleetingResponse)

    const filesBefore = (await readdir(root.root)).filter((name) =>
      name.endsWith(".md"),
    )

    const structured = await api.handler(
      request("/api/wiki/agent-memory?limit=5"),
    )
    expect(structured.status).toBe(200)
    const page = (await structured.json()) as {
      readonly tag: string
      readonly mode: string
      readonly noteCount: number
      readonly synthesis: {
        readonly configured: boolean
        readonly kind: string
        readonly detail: string
      }
      readonly sections: ReadonlyArray<{
        readonly heading: string
        readonly citations: ReadonlyArray<{
          readonly noteId: string
          readonly path: string
        }>
      }>
      readonly sources: ReadonlyArray<{ readonly id: string }>
      readonly markdown: string
    }
    expect(page).toMatchObject({
      tag: "agent-memory",
      mode: "extractive",
      noteCount: 1,
    })
    expect(page.synthesis.configured).toBe(false)
    expect(page.sections).toHaveLength(1)
    expect(page.sections[0]!.citations[0]).toMatchObject({
      noteId: note.id,
    })
    expect(page.sections[0]!.citations[0]!.path).toContain(note.id)
    expect(page.sources[0]!.id).toBe(note.id)
    expect(page.markdown).toContain(note.id)

    const withFleeting = await api.handler(
      request("/api/wiki/agent-memory?includeFleeting=true&limit=5"),
    )
    expect(withFleeting.status).toBe(200)
    const fleetingPage = (await withFleeting.json()) as {
      readonly noteCount: number
      readonly sources: ReadonlyArray<{ readonly id: string }>
    }
    expect(fleetingPage.noteCount).toBe(2)
    expect(fleetingPage.sources.map((source) => source.id)).toContain(
      fleeting.id,
    )

    const markdown = await api.handler(
      request("/api/wiki/agent-memory?format=markdown"),
    )
    expect(markdown.status).toBe(200)
    expect(markdown.headers.get("content-type")).toContain("text/markdown")
    expect(await markdown.text()).toContain("## Bounded recall")

    const empty = await api.handler(request("/api/wiki/no-such-tag"))
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { noteCount: number }).noteCount).toBe(0)

    const filesAfter = (await readdir(root.root)).filter((name) =>
      name.endsWith(".md"),
    )
    expect(filesAfter).toEqual(filesBefore)
  })
})

test("pending human review exposes a diff and approves or rejects without MCP approval", async () => {
  await withApi(async (api, root) => {
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({ root: root.root }),
    )
    const approval = await Effect.runPromise(
      makeApprovalService(repository, { now: () => Date.UTC(2026, 10, 17, 21, 0, 0) }),
    )

    const createPending = await Effect.runPromise(
      approval.submitMcp({
        operation: "create",
        type: "permanent",
        title: "Agent proposal",
        content: "Only a human may make this permanent.",
        actor: "agent-test",
      }),
    )
    expect(createPending.status).toBe("pending_approval")
    const createProposalId =
      createPending.status === "pending_approval"
        ? createPending.proposalId
        : ""

    const rejectSeed = await Effect.runPromise(
      approval.submitMcp({
        operation: "create",
        type: "permanent",
        title: "Rejected proposal",
        content: "This never becomes a note.",
      }),
    )
    const rejectProposalId =
      rejectSeed.status === "pending_approval" ? rejectSeed.proposalId : ""

    const pendingResponse = await api.handler(request("/api/pending"))
    expect(pendingResponse.status).toBe(200)
    const pending = (await pendingResponse.json()) as {
      readonly proposals: ReadonlyArray<{
        readonly id: string
        readonly operation: string
        readonly noteId: string
        readonly diff: string
        readonly stale: boolean
        readonly expired: boolean
      }>
    }
    expect(pending.proposals).toHaveLength(2)
    const proposal = pending.proposals.find(
      (item) => item.id === createProposalId,
    )!
    expect(proposal).toMatchObject({
      operation: "create",
      stale: false,
      expired: false,
    })
    expect(proposal.diff).toContain("+")
    expect(proposal.diff).toContain("Only a human may make this permanent.")

    // Pending proposals never appear as notes.
    const listBefore = await api.handler(request("/api/notes"))
    expect(await readNotes(listBefore)).toHaveLength(0)

    const approveResponse = await api.handler(
      request(`/api/pending/${createProposalId}/approve`, "POST"),
    )
    expect(approveResponse.status).toBe(200)
    const approved = (await approveResponse.json()) as {
      readonly status: string
      readonly note: ApiNoteResponse
    }
    expect(approved.status).toBe("applied")
    expect(approved.note).toMatchObject({
      title: "Agent proposal",
      type: "permanent",
    })

    // The approved note is visible through the same ID route and search index.
    const detail = await api.handler(
      request(`/api/notes/${approved.note.id}`),
    )
    expect((await readNote(detail)).id).toBe(approved.note.id)
    const search = await api.handler(request("/api/search?q=permanent"));
    const hits = (await search.json()) as {
      readonly results: ReadonlyArray<{ readonly id: string }>
    }
    expect(hits.results.map((hit) => hit.id)).toContain(approved.note.id)

    const rejectResponse = await api.handler(
      request(`/api/pending/${rejectProposalId}/reject`, "POST"),
    )
    expect(rejectResponse.status).toBe(200)
    expect(await rejectResponse.json()).toEqual({
      status: "rejected",
      proposalId: rejectProposalId,
    })

    const remaining = await api.handler(request("/api/pending"))
    expect(
      ((await remaining.json()) as { readonly proposals: ReadonlyArray<unknown> })
        .proposals,
    ).toHaveLength(0)

    const finalNotes = await readNotes(await api.handler(request("/api/notes")))
    expect(finalNotes.map((note) => note.title)).toEqual(["Agent proposal"])

    const crossOriginApprove = await api.handler(
      request(`/api/pending/${createProposalId}/approve`, "POST", undefined, {
        origin: "https://evil.example",
      }),
    )
    expect(crossOriginApprove.status).toBe(403)
  })
})

test("HTTP approval refreshes the derived index before the next check", async () => {
  await withApi(async (api, root) => {
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({ root: root.root }),
    )
    const approval = await Effect.runPromise(
      makeApprovalService(repository),
    )

    const checkDrift = async (): Promise<void> => {
      const index = await Effect.runPromise(
        makeMarkdownSearchIndex({
          root: root.root,
          cacheDir: root.cacheDir,
        }),
      )
      try {
        const snapshot = await Effect.runPromise(index.snapshot())
        const report = await Effect.runPromise(
          checkNoteRoot(root.root, {
            index: snapshot.map((entry) => ({
              id: entry.id,
              contentHash: entry.contentHash,
            })),
          }),
        )
        expect(report.index.drift).toBe(0)
        const codes = report.warnings.map((warning) => warning.code)
        expect(codes).not.toContain("index-missing")
        expect(codes).not.toContain("index-stale")
        expect(codes).not.toContain("index-extra")
      } finally {
        await Effect.runPromise(index.close())
      }
    }

    const createProposal = await Effect.runPromise(
      approval.submitMcp({
        operation: "create",
        type: "permanent",
        title: "HTTP approved create",
        content: "Created over HTTP, then checked without a search.",
      }),
    )
    if (createProposal.status !== "pending_approval") {
      throw new Error("expected pending create")
    }
    const createdResponse = await api.handler(
      request(`/api/pending/${createProposal.proposalId}/approve`, "POST"),
    )
    expect(createdResponse.status).toBe(200)
    const created = (await createdResponse.json()) as {
      readonly index: { readonly status: string }
    }
    expect(created.index.status).toBe("refreshed")
    await checkDrift()

    const base = await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: "HTTP approved update base",
        content: "Base body before approval.",
      }),
    )
    const updateProposal = await Effect.runPromise(
      approval.submitMcp({
        operation: "update",
        id: base.id,
        content: "Updated body through HTTP approval.",
      }),
    )
    if (updateProposal.status !== "pending_approval") {
      throw new Error("expected pending update")
    }
    const updatedResponse = await api.handler(
      request(`/api/pending/${updateProposal.proposalId}/approve`, "POST"),
    )
    expect(updatedResponse.status).toBe(200)
    const updated = (await updatedResponse.json()) as {
      readonly index: { readonly status: string }
    }
    expect(updated.index.status).toBe("refreshed")
    await checkDrift()

    const deleteProposal = await Effect.runPromise(
      approval.submitMcp({
        operation: "delete",
        id: base.id,
      }),
    )
    if (deleteProposal.status !== "pending_approval") {
      throw new Error("expected pending delete")
    }
    const deletedResponse = await api.handler(
      request(`/api/pending/${deleteProposal.proposalId}/approve`, "POST"),
    )
    expect(deletedResponse.status).toBe(200)
    const deleted = (await deletedResponse.json()) as {
      readonly index: { readonly status: string }
    }
    expect(deleted.index.status).toBe("refreshed")
    await checkDrift()
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
