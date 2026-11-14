import { expect, test } from "bun:test"
import {
  FleetingNoteNotFound,
  FleetingNoteService,
  LiteratureNoteService,
  NoteService,
  PermanentNoteService,
} from "@slipmem/core"
import { MemoryScope } from "@slipmem/schemas/memory-scope"
import { Provenance } from "@slipmem/schemas/provenance"
import { Effect, Option, Schema } from "effect"
import { makeApiHandler } from "./app"
import { makeDatabaseLayer } from "./database"

const scope = Schema.decodeUnknownSync(MemoryScope.Scope)
const alpha = scope("project:alpha")
const beta = scope("project:beta")

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(makeDatabaseLayer(":memory:")),
      ) as Effect.Effect<A, E>,
    ),
  )

interface Note {
  readonly id: string
  readonly type: "fleeting" | "literature" | "permanent"
  readonly title: string
  readonly content: string
  readonly reference?: string
  readonly scope: string
  readonly provenance: { readonly source: string; readonly actor?: string }
}

const scopedJsonRequest = (
  path: string,
  method: string,
  body?: unknown,
) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const list = async (
  api: ReturnType<typeof makeApiHandler>,
  path: string,
): Promise<ReadonlyArray<Note>> => {
  const response = await api.handler(new Request(`http://localhost${path}`))
  expect(response.status).toBe(200)
  return ((await response.json()) as { readonly notes: ReadonlyArray<Note> }).notes
}

test("SQLite CRUD is isolated by scope for every note kind", async () => {
  await run(
    Effect.gen(function* () {
      const fleeting = yield* FleetingNoteService
      const literature = yield* LiteratureNoteService
      const permanent = yield* PermanentNoteService

      const alphaFleeting = yield* fleeting.create({
        title: "Alpha fleeting",
        content: "alpha",
        scope: alpha,
        provenance: { source: "test", actor: "agent-a" },
      })
      const betaFleeting = yield* fleeting.create({
        title: "Beta fleeting",
        content: "beta",
        scope: beta,
      })
      const alphaLiterature = yield* literature.create({
        title: "Alpha literature",
        content: "quote",
        reference: "Book",
        scope: alpha,
      })
      const alphaPermanent = yield* permanent.create({
        title: "Alpha permanent",
        content: "idea",
        scope: alpha,
      })

      expect(alphaFleeting.scope).toBe(alpha)
      expect(alphaFleeting.provenance).toEqual({
        source: "test",
        actor: "agent-a",
      })
      expect(betaFleeting.scope).toBe(beta)
      expect(betaFleeting.provenance).toEqual(Provenance.UNKNOWN)

      expect(yield* fleeting.list({ scope: alpha })).toEqual([alphaFleeting])
      expect(yield* fleeting.list({ scope: beta })).toEqual([betaFleeting])

      // A valid id from another namespace is indistinguishable from missing.
      expect(
        Option.isNone(yield* fleeting.get({ id: betaFleeting.id, scope: alpha })),
      ).toBe(true)
      expect(
        Option.getOrThrow(
          yield* fleeting.get({ id: alphaFleeting.id, scope: alpha }),
        ),
      ).toEqual(alphaFleeting)

      const notFound = yield* Effect.flip(
        fleeting.update({
          id: betaFleeting.id,
          title: "Wrong scope",
          content: "should not change",
          scope: alpha,
        }),
      )
      expect(notFound).toBeInstanceOf(FleetingNoteNotFound)
      expect(
        Option.getOrThrow(
          yield* fleeting.get({ id: betaFleeting.id, scope: beta }),
        ).title,
      ).toBe("Beta fleeting")

      expect(
        yield* fleeting.delete({ id: alphaFleeting.id, scope: beta }),
      ).toBe(false)
      expect(
        Option.isSome(
          yield* fleeting.get({ id: alphaFleeting.id, scope: alpha }),
        ),
      ).toBe(true)

      const notes = yield* NoteService
      expect(
        (yield* notes.list({ scope: alpha })).map((note) => note.id).sort(),
      ).toEqual(
        [alphaFleeting.id, alphaLiterature.id, alphaPermanent.id].sort(),
      )
      expect(yield* notes.list({ scope: beta })).toEqual([
        { ...betaFleeting, type: "fleeting" },
      ])
      expect(
        (yield* notes.listTitles({ scope: beta })).map((note) => note.id),
      ).toEqual([betaFleeting.id])
    }),
  )
})

test("omitting a scope preserves the legacy default namespace", async () => {
  await run(
    Effect.gen(function* () {
      const fleeting = yield* FleetingNoteService
      const notes = yield* NoteService

      const created = yield* fleeting.create({
        title: "Unscoped",
        content: "legacy caller",
      })

      expect(created.scope).toBe(MemoryScope.DEFAULT_SCOPE)
      expect(created.provenance).toEqual(Provenance.UNKNOWN)
      expect(yield* fleeting.list({})).toEqual([created])
      expect(yield* notes.list({})).toEqual([
        { ...created, type: "fleeting" },
      ])
      expect(yield* notes.list({ scope: alpha })).toEqual([])
    }),
  )
})

test("the JSON API reads and writes inside one scope", async () => {
  const api = makeApiHandler(":memory:", { disableLogger: true })

  try {
    const alphaPath = `/api/notes/fleeting?scope=${encodeURIComponent(alpha)}`
    const betaPath = `/api/notes/fleeting?scope=${encodeURIComponent(beta)}`

    const createdResponse = await api.handler(
      scopedJsonRequest(alphaPath, "POST", {
        title: "Scoped",
        content: "only alpha",
      }),
    )
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as Note
    expect(created.scope).toBe(alpha)
    expect(created.provenance).toEqual(Provenance.API)

    expect(await list(api, alphaPath)).toEqual([created])
    expect(await list(api, betaPath)).toEqual([])

    const wrongScopeGet = await api.handler(
      new Request(
        `http://localhost/api/notes/fleeting/${created.id}?scope=${encodeURIComponent(beta)}`,
      ),
    )
    expect(wrongScopeGet.status).toBe(200)
    expect(await wrongScopeGet.json()).toEqual({ note: null })

    const wrongScopeUpdate = await api.handler(
      scopedJsonRequest(
        `/api/notes/fleeting/${created.id}?scope=${encodeURIComponent(beta)}`,
        "PUT",
        { title: "Wrong", content: "scope" },
      ),
    )
    expect(wrongScopeUpdate.status).toBe(404)

    const wrongScopeDelete = await api.handler(
      new Request(
        `http://localhost/api/notes/fleeting/${created.id}?scope=${encodeURIComponent(beta)}`,
        { method: "DELETE" },
      ),
    )
    expect(await wrongScopeDelete.json()).toEqual({ deleted: false })

    const invalidScope = await api.handler(
      new Request("http://localhost/api/notes?scope=not%20a%20scope"),
    )
    expect(invalidScope.status).toBe(400)
    expect(await invalidScope.json()).toEqual({
      error: "Invalid scope: not a scope",
    })
  } finally {
    await api.dispose()
  }
})
