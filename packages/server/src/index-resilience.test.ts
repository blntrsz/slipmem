import { expect, test } from "bun:test"
import {
  indexDatabasePath,
  initializeNoteRoot,
  makeApprovalService,
  makeMarkdownNoteRepository,
} from "@slipmem/core"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeApiHandler } from "./app"

const ORIGIN = "http://127.0.0.1:3000"

const request = (
  path: string,
  method = "GET",
  body?: unknown,
) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test("a corrupt index does not block notes or approvals and self-heals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-index-resilience-"))
  const root = join(directory, ".slipmem")
  const cacheDir = join(directory, "cache")
  let api: ReturnType<typeof makeApiHandler> | undefined
  try {
    await Effect.runPromise(initializeNoteRoot(root))
    const repository = await Effect.runPromise(
      makeMarkdownNoteRepository({
        root,
        backupDir: join(directory, "trash"),
      }),
    )
    const existing = await Effect.runPromise(
      repository.create({
        type: "permanent",
        title: "Existing note",
        content: "The note file must stay readable while the cache is broken.",
      }),
    )
    const approval = await Effect.runPromise(
      makeApprovalService(repository),
    )
    const submitted = await Effect.runPromise(
      approval.submitMcp({
        operation: "create",
        type: "permanent",
        title: "Approved while cache is broken",
        content: "Approval must not depend on a readable search index.",
      }),
    )
    if (submitted.status !== "pending_approval") {
      throw new Error("expected a pending proposal")
    }

    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      indexDatabasePath({ root, cacheDir }),
      "this is not a sqlite database",
    )

    api = makeApiHandler(root, { cacheDir, disableLogger: true })
    await api.ready

    const list = await api.handler(request("/api/notes"))
    expect(list.status).toBe(200)
    const listed = (await list.json()) as {
      readonly notes: ReadonlyArray<{ readonly id: string }>
    }
    expect(listed.notes.map((note) => note.id)).toContain(existing.id)

    const detail = await api.handler(request(`/api/notes/${existing.id}`))
    expect(detail.status).toBe(200)

    const pending = await api.handler(request("/api/pending"))
    expect(pending.status).toBe(200)
    const pendingBody = (await pending.json()) as {
      readonly proposals: ReadonlyArray<{ readonly id: string }>
    }
    expect(pendingBody.proposals.map((item) => item.id)).toContain(
      submitted.proposalId,
    )

    const approved = await api.handler(
      request(`/api/pending/${submitted.proposalId}/approve`, "POST"),
    )
    expect(approved.status).toBe(200)
    const approvedBody = (await approved.json()) as {
      readonly status: string
      readonly note: { readonly id: string }
      readonly index: { readonly status: string }
    }
    expect(approvedBody.status).toBe("applied")
    // The resilient index removed the corrupt file and rebuilt from Markdown.
    expect(approvedBody.index.status).toBe("refreshed")

    const health = await api.handler(request("/api/health"))
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as {
      readonly index: { readonly noteCount: number }
    }
    expect(healthBody.index.noteCount).toBe(2)

    const search = await api.handler(request("/api/search?q=readable"))
    expect(search.status).toBe(200)
    const searchBody = (await search.json()) as {
      readonly results: ReadonlyArray<{ readonly id: string }>
    }
    expect(searchBody.results.map((item) => item.id)).toContain(existing.id)
  } finally {
    await api?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
