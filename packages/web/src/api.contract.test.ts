import { expect, test } from "bun:test"
import { makeApiHandler } from "@slipmem/server"
import { Effect } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createNote,
  getNote,
  listNotes,
  listTags,
  searchNotes,
  updateNote,
} from "./api"

/**
 * Contract test across the real server handler and the browser client.
 *
 * The requests still travel through `HttpClientRequest` and the response
 * bodies are produced by `makeApiHandler`, so this fails if the server's note
 * wire shape drifts away from the schemas the web client decodes. It is not a
 * UI test: no route or view code runs here.
 */
const ORIGIN = "http://127.0.0.1:3000"

const makeHttpClient = (
  api: ReturnType<typeof makeApiHandler>,
): HttpClient.HttpClient =>
  HttpClient.makeWith(
    Effect.fnUntraced(function* (requestEffect) {
      const request = yield* requestEffect
      // The client builds origin-relative paths; the handler needs a real URL.
      const webRequest = yield* HttpClientRequest.toWeb(
        HttpClientRequest.prependUrl(ORIGIN)(request),
      ).pipe(Effect.orDie)
      const response = yield* Effect.promise(() => api.handler(webRequest))
      return HttpClientResponse.fromWeb(request, response)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<never, never>,
    // The handler cannot fail with a typed error (a rejection becomes a
    // defect), so widening the client's error type is safe and keeps the
    // client usable wherever the app expects an ordinary `HttpClient`.
  ) as unknown as HttpClient.HttpClient

const run = <A, E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> =>
  Effect.runPromise(Effect.provideService(effect, HttpClient.HttpClient, client))

test("the web API client decodes real note responses from the server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-web-contract-"))
  const root = join(directory, ".slipmem")
  await mkdir(root, { recursive: true })
  const api = makeApiHandler(root, {
    cacheDir: join(directory, "cache"),
    disableLogger: true,
  })

  try {
    await api.ready
    const client = makeHttpClient(api)

    expect(await run(client, listNotes())).toEqual([])

    const created = await run(
      client,
      createNote("permanent", {
        title: "Web contract",
        content: "The decoder must accept the server's note shape.",
        tags: ["agent-memory"],
      }),
    )
    expect(created).toMatchObject({
      type: "permanent",
      title: "Web contract",
      tags: ["agent-memory"],
    })
    expect(created.contentHash.length).toBeGreaterThan(0)

    const listed = await run(client, listNotes({ type: "permanent" }))
    expect(listed.map((note) => note.id)).toContain(created.id)

    expect(await run(client, getNote(created.id))).toEqual(created)

    const updated = await run(
      client,
      updateNote(
        created.id,
        {
          title: "Web contract",
          content: "Updated through the real HTTP surface.",
          tags: ["agent-memory"],
        },
        created.contentHash,
      ),
    )
    expect(updated.content).toBe("Updated through the real HTTP surface.")
    expect(updated.contentHash).not.toBe(created.contentHash)

    const hits = await run(client, searchNotes({ query: "HTTP surface" }))
    expect(hits.map((hit) => hit.id)).toContain(created.id)
    expect(hits[0]?.note.id).toBe(created.id)

    expect(await run(client, listTags())).toContainEqual({
      tag: "agent-memory",
      noteCount: 1,
      byType: { fleeting: 0, literature: 0, permanent: 1 },
    })
  } finally {
    await api.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
