import { expect, test } from "bun:test"
import {
  initializeNoteRoot,
  makeApprovalService,
  makeMarkdownNoteRepository,
  type ApprovalServiceShape,
} from "@slipmem/core"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
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

interface Fixture {
  readonly api: ReturnType<typeof makeApiHandler>
  readonly root: string
  readonly approval: ApprovalServiceShape
}

const withApi = async <A>(run: (fixture: Fixture) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-api-approval-errors-"))
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  const repository = await Effect.runPromise(
    makeMarkdownNoteRepository({
      root,
      backupDir: join(directory, "trash"),
    }),
  )
  const approval = await Effect.runPromise(
    makeApprovalService(repository, { env: {} }),
  )
  const api = makeApiHandler(root, {
    cacheDir: join(directory, "cache"),
    disableLogger: true,
  })
  try {
    return await run({ api, root, approval })
  } finally {
    await api.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

const createNote = async (
  api: ReturnType<typeof makeApiHandler>,
): Promise<{ readonly id: string; readonly content: string }> => {
  const response = await api.handler(
    request("/api/notes", "POST", {
      type: "permanent",
      title: "Approval error target",
      content: "Original body.",
    }),
  )
  expect(response.status).toBe(201)
  const body = (await response.json()) as {
    readonly note: { readonly id: string; readonly content: string }
  }
  return body.note
}

const submitUpdate = async (
  fixture: Fixture,
  noteId: string,
): Promise<string> => {
  const result = await Effect.runPromise(
    fixture.approval.submitMcp({
      operation: "update",
      id: noteId,
      content: "Approved body.",
    }),
  )
  if (result.status !== "pending_approval") {
    throw new Error("expected a pending proposal")
  }
  return result.proposalId
}

const proposalFile = (fixture: Fixture, proposalId: string): string =>
  join(fixture.root, ".state", "pending", `${proposalId}.json`)

const intentFile = (fixture: Fixture, proposalId: string): string =>
  join(fixture.root, ".state", "apply-intent", `${proposalId}.json`)

test("maps apply-unknown to HTTP 409 without changing the note", async () => {
  await withApi(async (fixture) => {
    const note = await createNote(fixture.api)
    const proposalId = await submitUpdate(fixture, note.id)

    mkdirSync(join(fixture.root, ".state", "apply-intent"), {
      recursive: true,
    })
    writeFileSync(intentFile(fixture, proposalId), "{not json", "utf8")

    const response = await fixture.api.handler(
      request(`/api/pending/${proposalId}/approve`, "POST"),
    )
    expect(response.status).toBe(409)
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "apply-unknown",
    })

    const stored = await fixture.api.handler(
      request(`/api/notes/${note.id}`),
    )
    const body = (await stored.json()) as {
      readonly note: { readonly content: string }
    }
    expect(body.note.content).toBe("Original body.")
  })
})

test("maps apply-conflict to HTTP 409 and preserves the external edit", async () => {
  await withApi(async (fixture) => {
    const note = await createNote(fixture.api)
    const proposalId = await submitUpdate(fixture, note.id)
    const proposal = JSON.parse(
      readFileSync(proposalFile(fixture, proposalId), "utf8"),
    ) as {
      readonly operation: string
      readonly noteId: string
      readonly path: string
      readonly baseHash: string
      readonly content: string
    }
    const proposalHash = createHash("sha256")
      .update(
        JSON.stringify({
          operation: proposal.operation,
          noteId: proposal.noteId,
          path: proposal.path,
          baseHash: proposal.baseHash,
          content: proposal.content,
        }),
      )
      .digest("hex")
    mkdirSync(join(fixture.root, ".state", "apply-intent"), {
      recursive: true,
    })
    writeFileSync(
      intentFile(fixture, proposalId),
      JSON.stringify({
        proposalId,
        operation: proposal.operation,
        noteId: proposal.noteId,
        path: proposal.path,
        phase: "prepared",
        baseHash: proposal.baseHash,
        proposalHash,
        preparedAt: new Date().toISOString(),
      }),
      "utf8",
    )

    const external = await fixture.api.handler(
      request(`/api/notes/${note.id}`, "PUT", {
        content: "External edit wins.",
      }),
    )
    expect(external.status).toBe(200)

    const response = await fixture.api.handler(
      request(`/api/pending/${proposalId}/approve`, "POST"),
    )
    expect(response.status).toBe(409)
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "apply-conflict",
    })

    const stored = await fixture.api.handler(
      request(`/api/notes/${note.id}`),
    )
    const body = (await stored.json()) as {
      readonly note: { readonly content: string }
    }
    expect(body.note.content).toBe("External edit wins.")
  })
})
