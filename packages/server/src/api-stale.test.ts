import { expect, test } from "bun:test"
import { initializeNoteRoot } from "@slipmem/core"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeApiHandler } from "./app"

interface ApiNoteResponse {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly contentHash: string
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

const withApi = async <A>(
  run: (api: ReturnType<typeof makeApiHandler>, root: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-api-stale-"))
  const root = join(directory, ".slipmem")
  await Effect.runPromise(initializeNoteRoot(root))
  const api = makeApiHandler(root, {
    cacheDir: join(directory, "cache"),
    disableLogger: true,
  })
  try {
    return await run(api, root)
  } finally {
    await api.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

const readNote = async (response: Response): Promise<ApiNoteResponse> => {
  const body = (await response.json()) as { readonly note: ApiNoteResponse }
  return body.note
}

const createNote = async (
  api: ReturnType<typeof makeApiHandler>,
  title: string,
): Promise<ApiNoteResponse> =>
  readNote(
    await api.handler(
      request("/api/notes", "POST", {
        type: "permanent",
        title,
        content: "Original body.",
      }),
    ),
  )

test("conditional updates accept If-Match and a body revision", async () => {
  await withApi(async (api) => {
    const created = await createNote(api, "Conditional update")

    const item = await api.handler(request(`/api/notes/${created.id}`))
    expect(item.headers.get("etag")).toBe(`"${created.contentHash}"`)

    const first = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        { title: "First update", content: "First body." },
        { "if-match": `"${created.contentHash}"` },
      ),
    )
    expect(first.status).toBe(200)
    const firstNote = await readNote(first)
    expect(firstNote.contentHash).not.toBe(created.contentHash)

    const stale = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        { title: "Stale overwrite", content: "Must not land." },
        { "if-match": `"${created.contentHash}"` },
      ),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()) as { code: string }).toMatchObject({
      code: "stale-base",
    })

    const unchanged = await readNote(
      await api.handler(request(`/api/notes/${created.id}`)),
    )
    expect(unchanged).toMatchObject({
      title: "First update",
      content: "First body.",
      contentHash: firstNote.contentHash,
    })

    const bodyRevision = await api.handler(
      request(`/api/notes/${created.id}`, "PUT", {
        title: "Body revision",
        content: "Applied with a body revision.",
        revision: firstNote.contentHash,
      }),
    )
    expect(bodyRevision.status).toBe(200)
    const bodyNote = await readNote(bodyRevision)

    const aliasRevision = await api.handler(
      request(`/api/notes/${created.id}`, "PUT", {
        title: "Hash alias",
        content: "Applied with the contentHash alias.",
        contentHash: bodyNote.contentHash,
      }),
    )
    expect(aliasRevision.status).toBe(200)

    const disagreement = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        {
          title: "Conflicting guards",
          content: "Must not land.",
          revision: created.contentHash,
        },
        { "if-match": `"${bodyNote.contentHash}"` },
      ),
    )
    expect(disagreement.status).toBe(400)
    expect((await disagreement.json()) as { code: string }).toMatchObject({
      code: "conflicting-revision",
    })

    // A client that sends no revision keeps the pre-guard behavior.
    const legacy = await api.handler(
      request(`/api/notes/${created.id}`, "PUT", {
        title: "Legacy client",
        content: "Still allowed.",
      }),
    )
    expect(legacy.status).toBe(200)
  })
})

test("conditional deletes refuse a stale revision and accept the read one", async () => {
  await withApi(async (api) => {
    const created = await createNote(api, "Conditional delete")

    const stale = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "DELETE",
        undefined,
        { "if-match": `"${"a".repeat(64)}"` },
      ),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()) as { code: string }).toMatchObject({
      code: "stale-base",
    })
    expect((await api.handler(request(`/api/notes/${created.id}`))).status).toBe(
      200,
    )

    const deleted = await api.handler(
      request(`/api/notes/${created.id}?revision=${created.contentHash}`, "DELETE"),
    )
    expect(deleted.status).toBe(200)
    expect((await deleted.json()) as { deleted: boolean }).toMatchObject({
      deleted: true,
    })
    expect((await api.handler(request(`/api/notes/${created.id}`))).status).toBe(
      404,
    )
  })
})

test("DELETE honors JSON body revision guards", async () => {
  await withApi(async (api) => {
    const created = await createNote(api, "Delete body guard")

    const stale = await api.handler(
      request(`/api/notes/${created.id}`, "DELETE", {
        revision: "a".repeat(64),
      }),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()) as { code: string }).toMatchObject({
      code: "stale-base",
    })
    expect((await api.handler(request(`/api/notes/${created.id}`))).status).toBe(
      200,
    )

    const deleted = await api.handler(
      request(`/api/notes/${created.id}`, "DELETE", {
        revision: created.contentHash,
      }),
    )
    expect(deleted.status).toBe(200)
    expect((await api.handler(request(`/api/notes/${created.id}`))).status).toBe(
      404,
    )

    const alias = await createNote(api, "Delete body alias")
    const aliasDeleted = await api.handler(
      request(`/api/notes/${alias.id}`, "DELETE", {
        expectedContentHash: alias.contentHash,
      }),
    )
    expect(aliasDeleted.status).toBe(200)
  })
})

test("empty or disagreeing query aliases fail closed instead of allowing a blind write", async () => {
  await withApi(async (api) => {
    const created = await createNote(api, "Query guard")

    const emptyPut = await api.handler(
      request(`/api/notes/${created.id}?revision=`, "PUT", {
        title: "Empty guard",
        content: "Must not land.",
      }),
    )
    expect(emptyPut.status).toBe(400)
    expect((await emptyPut.json()) as { code: string }).toMatchObject({
      code: "invalid-revision",
    })

    const disagreeingPut = await api.handler(
      request(
        `/api/notes/${created.id}?revision=${created.contentHash}&contentHash=${"b".repeat(64)}`,
        "PUT",
        { title: "Disagreeing guard", content: "Must not land." },
      ),
    )
    expect(disagreeingPut.status).toBe(400)
    expect((await disagreeingPut.json()) as { code: string }).toMatchObject({
      code: "conflicting-revision",
    })

    expect(await readNote(await api.handler(request(`/api/notes/${created.id}`))))
      .toMatchObject({ title: "Query guard", content: "Original body." })

    const emptyDelete = await api.handler(
      request(`/api/notes/${created.id}?revision=`, "DELETE"),
    )
    expect(emptyDelete.status).toBe(400)
    expect((await emptyDelete.json()) as { code: string }).toMatchObject({
      code: "invalid-revision",
    })

    const disagreeingDelete = await api.handler(
      request(
        `/api/notes/${created.id}?revision=${created.contentHash}&expectedContentHash=${"b".repeat(64)}`,
        "DELETE",
      ),
    )
    expect(disagreeingDelete.status).toBe(400)
    expect((await disagreeingDelete.json()) as { code: string }).toMatchObject({
      code: "conflicting-revision",
    })
    expect((await api.handler(request(`/api/notes/${created.id}`))).status).toBe(
      200,
    )

    // Matching aliases are accepted and still guard the write.
    const agreeingPut = await api.handler(
      request(
        `/api/notes/${created.id}?revision=${created.contentHash}&contentHash=${created.contentHash}`,
        "PUT",
        { title: "Agreeing guard", content: "Applied once." },
      ),
    )
    expect(agreeingPut.status).toBe(200)
    const updated = await readNote(agreeingPut)

    const agreeingDelete = await api.handler(
      request(
        `/api/notes/${created.id}?revision=${updated.contentHash}&expectedContentHash=${updated.contentHash}`,
        "DELETE",
      ),
    )
    expect(agreeingDelete.status).toBe(200)
  })
})

test("If-Match rejects weak validators and OR-lists but accepts one strong token", async () => {
  await withApi(async (api) => {
    const created = await createNote(api, "If-Match forms")

    const weakPut = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        { title: "Weak guard", content: "Must not land." },
        { "if-match": `W/"${created.contentHash}"` },
      ),
    )
    expect(weakPut.status).toBe(400)
    expect((await weakPut.json()) as { code: string }).toMatchObject({
      code: "invalid-revision",
    })

    const weakDelete = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "DELETE",
        undefined,
        { "if-match": `W/"${created.contentHash}"` },
      ),
    )
    expect(weakDelete.status).toBe(400)
    expect((await weakDelete.json()) as { code: string }).toMatchObject({
      code: "invalid-revision",
    })

    const listPut = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        { title: "OR list", content: "Must not land." },
        { "if-match": `"${created.contentHash}", "${"b".repeat(64)}"` },
      ),
    )
    expect(listPut.status).toBe(400)
    expect((await listPut.json()) as { code: string }).toMatchObject({
      code: "invalid-revision",
    })

    expect(await readNote(await api.handler(request(`/api/notes/${created.id}`))))
      .toMatchObject({ title: "If-Match forms", content: "Original body." })

    // Bare tokens are the documented compatibility form; `*` only requires
    // existence, which the repository mutation already checks.
    const barePut = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "PUT",
        { title: "Bare token", content: "Applied with a bare token." },
        { "if-match": created.contentHash },
      ),
    )
    expect(barePut.status).toBe(200)

    const starDelete = await api.handler(
      request(
        `/api/notes/${created.id}`,
        "DELETE",
        undefined,
        { "if-match": "*" },
      ),
    )
    expect(starDelete.status).toBe(200)
  })
})
