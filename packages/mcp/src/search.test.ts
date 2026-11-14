import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { McpProtocol, McpTest } from "effect/ai"
import { makeDatabaseLayer } from "@slipmem/server"
import { NoteRegistrations } from "@slipmem/server/note-tools"

interface SearchMatch {
  readonly note: {
    readonly id: string
    readonly type: "fleeting" | "literature" | "permanent"
    readonly title: string
    readonly content: string
    readonly reference?: string
    readonly scope: string
    readonly provenance: { readonly source: string }
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly score: number
  readonly fields: ReadonlyArray<"title" | "content" | "reference">
}

interface SearchResult {
  readonly query: string
  readonly limit: number
  readonly hasMore: boolean
  readonly matches: ReadonlyArray<SearchMatch>
}

const makeClient = () =>
  McpTest.makeClient(
    NoteRegistrations.pipe(Layer.provide(makeDatabaseLayer(":memory:"))),
    { protocols: [McpProtocol.v2025_11_25] },
  )

const runWithClient = <A, E>(
  effect: (client: McpTest.Client) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient()
        return yield* effect(client)
      }),
    ),
  )

const create = (
  client: McpTest.Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
) =>
  client.callTool({
    name,
    arguments: args,
  })

const search = (
  client: McpTest.Client,
  args: Readonly<Record<string, unknown>>,
) =>
  client.callTool({ name: "search_notes", arguments: args }).pipe(
    Effect.map((result) => {
      expect(result.isError).toBeFalsy()
      return result.structuredContent as SearchResult
    }),
  )

test("search_notes is a bounded read-only tool", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const tools = yield* client.listTools()
      const searchTool = tools.tools.find((tool) => tool.name === "search_notes")

      expect(searchTool).toBeDefined()
      expect(searchTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      })
    }),
  )
})

test("searches only the selected scope and defaults to global", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const alpha = yield* create(client, "create_fleeting_note", {
        title: "Scoped memory alpha",
        content: "alpha-only note",
        scope: "project:alpha",
      })
      const beta = yield* create(client, "create_permanent_note", {
        title: "Scoped memory beta",
        content: "rollback plan for beta",
        scope: "project:beta",
      })
      const global = yield* create(client, "create_literature_note", {
        title: "Scoped memory global",
        content: "a quote",
        reference: "Scoped Book",
        scope: "global",
      })

      expect(alpha.isError).toBeFalsy()
      expect(beta.isError).toBeFalsy()
      expect(global.isError).toBeFalsy()

      const defaultScope = yield* search(client, { query: "scoped memory" })
      expect(defaultScope.matches.map((match) => match.note.type)).toEqual([
        "literature",
      ])
      expect(defaultScope.matches[0]!.note.scope).toBe("global")
      expect(defaultScope.matches[0]!.note.title).toBe("Scoped memory global")
      expect(defaultScope.matches[0]!.fields).toEqual(["title", "reference"])

      const alphaResult = yield* search(client, { query: "scoped", scope: "project:alpha" })
      expect(alphaResult.matches).toHaveLength(1)
      expect(alphaResult.matches[0]!.note).toMatchObject({
        type: "fleeting",
        title: "Scoped memory alpha",
        scope: "project:alpha",
        provenance: { source: "mcp" },
      })

      const betaResult = yield* search(client, { query: "scoped", scope: "project:beta" })
      expect(betaResult.matches).toHaveLength(1)
      expect(betaResult.matches[0]!.note).toMatchObject({
        type: "permanent",
        title: "Scoped memory beta",
        scope: "project:beta",
      })

      // A term that exists only in beta must not leak into an alpha search.
      const noLeak = yield* search(client, { query: "rollback", scope: "project:alpha" })
      expect(noLeak.matches).toEqual([])

      const missing = yield* search(client, { query: "scoped", scope: "project:missing" })
      expect(missing.matches).toEqual([])
    }),
  )
})

test("filters by kind and enforces the default and hard result limits", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      for (let index = 0; index < 51; index += 1) {
        const created = yield* create(client, "create_permanent_note", {
          title: `Bounded alpha ${index}`,
          content: "body text",
        })
        expect(created.isError).toBeFalsy()
      }

      const defaultLimit = yield* search(client, { query: "bounded" })
      expect(defaultLimit.limit).toBe(10)
      expect(defaultLimit.matches).toHaveLength(10)
      expect(defaultLimit.hasMore).toBe(true)

      const small = yield* search(client, { query: "bounded", limit: 3 })
      expect(small.limit).toBe(3)
      expect(small.matches).toHaveLength(3)
      expect(small.hasMore).toBe(true)

      const zero = yield* search(client, { query: "bounded", limit: 0 })
      expect(zero.limit).toBe(1)
      expect(zero.matches).toHaveLength(1)
      expect(zero.hasMore).toBe(true)

      const huge = yield* search(client, { query: "bounded", limit: 10_000 })
      expect(huge.limit).toBe(50)
      expect(huge.matches).toHaveLength(50)
      expect(huge.hasMore).toBe(true)

      const kindFiltered = yield* search(client, { query: "bounded", kinds: ["fleeting"], limit: 50 })
      expect(kindFiltered.matches).toEqual([])
      expect(kindFiltered.limit).toBe(50)
      expect(kindFiltered.hasMore).toBe(false)
    }),
  )
})

test("rejects malformed scopes and returns empty results for empty queries", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const invalid = yield* client.callTool({
        name: "search_notes",
        arguments: { query: "anything", scope: "not a scope" },
      })
      expect(invalid.isError).toBe(true)

      const empty = yield* search(client, { query: "   " })
      expect(empty).toEqual({
        query: "   ",
        limit: 10,
        hasMore: false,
        matches: [],
      })

      // The server stays usable after a rejected request.
      const created = yield* create(client, "create_permanent_note", {
        title: "Still alive",
        content: "usable after validation error",
      })
      expect(created.isError).toBeFalsy()
    }),
  )
})

test("reflects updates and deletes in the same server session", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const created = yield* create(client, "create_permanent_note", {
        title: "Dynamic search",
        content: "original term",
      })
      expect(created.isError).toBeFalsy()
      const note = created.structuredContent as { readonly id: string }

      const before = yield* search(client, { query: "original" })
      expect(before.matches.map((match) => match.note.id)).toEqual([note.id])

      const updated = yield* client.callTool({
        name: "update_permanent_note",
        arguments: {
          id: note.id,
          title: "Dynamic search",
          content: "replacement term",
        },
      })
      expect(updated.isError).toBeFalsy()

      const oldTerm = yield* search(client, { query: "original" })
      expect(oldTerm.matches).toEqual([])

      const newTerm = yield* search(client, { query: "replacement" })
      expect(newTerm.matches.map((match) => match.note.id)).toEqual([note.id])

      const deleted = yield* client.callTool({
        name: "delete_permanent_note",
        arguments: { id: note.id },
      })
      expect(deleted.structuredContent).toEqual({ deleted: true })

      const afterDelete = yield* search(client, { query: "replacement" })
      expect(afterDelete.matches).toEqual([])
    }),
  )
})
