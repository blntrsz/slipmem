import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { McpProtocol, McpTest } from "effect/ai"
import { makeDatabaseLayer } from "./database"
import { NoteRegistrations } from "./tools"

const noteToolNames = [
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
]

const makeClient = (databasePath = ":memory:") =>
  McpTest.makeClient(
    NoteRegistrations.pipe(Layer.provide(makeDatabaseLayer(databasePath))),
    { protocols: [McpProtocol.v2025_11_25] },
  )

const runWithClient = <A, E>(
  effect: (client: McpTest.Client) => Effect.Effect<A, E>,
  databasePath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient(databasePath)
        return yield* effect(client)
      }),
    ),
  )

interface Note {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly reference?: string
}

test("exposes CRUD tools for every note slice", async () => {
  const tools = await runWithClient((client) => client.listTools())

  expect(tools.tools.map((tool) => tool.name)).toEqual(noteToolNames)
})

test("creates, reads, updates, and deletes a fleeting note", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const created = yield* client.callTool({
        name: "create_fleeting_note",
        arguments: { title: "First", content: "hello" },
      })
      expect(created.isError).toBeFalsy()
      const note = created.structuredContent as Note
      expect(note.title).toBe("First")
      expect(note.content).toBe("hello")
      expect(note.id.length).toBeGreaterThan(0)

      const fetched = yield* client.callTool({
        name: "get_fleeting_note",
        arguments: { id: note.id },
      })
      expect(fetched.structuredContent).toEqual({ note })

      const listed = yield* client.callTool({ name: "list_fleeting_notes", arguments: {} })
      expect(listed.structuredContent).toEqual({ notes: [note] })

      const updated = yield* client.callTool({
        name: "update_fleeting_note",
        arguments: { id: note.id, title: "Updated", content: "changed" },
      })
      expect(updated.structuredContent).toMatchObject({ id: note.id, title: "Updated", content: "changed" })

      const deleted = yield* client.callTool({
        name: "delete_fleeting_note",
        arguments: { id: note.id },
      })
      expect(deleted.structuredContent).toEqual({ deleted: true })

      const missing = yield* client.callTool({
        name: "get_fleeting_note",
        arguments: { id: note.id },
      })
      expect(missing.structuredContent).toEqual({ note: null })
    }),
  )
})

test("reports missing notes as declared tool failures", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const result = yield* client.callTool({
        name: "update_fleeting_note",
        arguments: { id: "missing", title: "Nope", content: "Nope" },
      })

      expect(result.isError).toBe(true)
      const [content] = result.content
      expect(content).toMatchObject({ type: "text" })
      expect((content as { text: string }).text).toContain("Fleeting note not found: missing")
    }),
  )
})

test("supports permanent and literature notes", async () => {
  await runWithClient((client) =>
    Effect.gen(function* () {
      const permanent = yield* client.callTool({
        name: "create_permanent_note",
        arguments: { title: "Evergreen", content: "A lasting idea" },
      })
      expect(permanent.structuredContent).toMatchObject({ title: "Evergreen", content: "A lasting idea" })

      const literature = yield* client.callTool({
        name: "create_literature_note",
        arguments: { title: "Source", content: "A quote", reference: "Book, chapter 2" },
      })
      expect(literature.structuredContent).toMatchObject({
        title: "Source",
        content: "A quote",
        reference: "Book, chapter 2",
      })

      const permanentList = yield* client.callTool({ name: "list_permanent_notes", arguments: {} })
      expect(permanentList.structuredContent).toEqual({ notes: [permanent.structuredContent] })

      const literatureList = yield* client.callTool({ name: "list_literature_notes", arguments: {} })
      expect(literatureList.structuredContent).toEqual({ notes: [literature.structuredContent] })
    }),
  )
})

test("adopts a populated database created by the old bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-legacy-"))
  const databasePath = join(directory, "notes.db")
  const legacy = new Database(databasePath)

  try {
    legacy.exec(`
      CREATE TABLE fleeting_note (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
    `)
    legacy
      .query(
        "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("legacy", "Old note", "from before migrations", 1, 2)
  } finally {
    legacy.close()
  }

  try {
    const notes = await runWithClient(
      (client) =>
        Effect.gen(function* () {
          const result = yield* client.callTool({
            name: "list_fleeting_notes",
            arguments: {},
          })
          return (result.structuredContent as { notes: ReadonlyArray<Note> }).notes
        }),
      databasePath,
    )

    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: "legacy", title: "Old note" })

    const db = new Database(databasePath)
    try {
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(
        ["__drizzle_migrations", "fleeting_note", "literature_note", "permanent_note"].sort(),
      )
    } finally {
      db.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("persists notes in a SQLite file across server runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-"))
  const databasePath = join(directory, "notes.db")

  try {
    const id = await runWithClient(
      (client) =>
        Effect.gen(function* () {
          const result = yield* client.callTool({
            name: "create_permanent_note",
            arguments: { title: "Persisted", content: "still here" },
          })
          return (result.structuredContent as Note).id
        }),
      databasePath,
    )

    const notes = await runWithClient(
      (client) =>
        Effect.gen(function* () {
          const result = yield* client.callTool({ name: "list_permanent_notes", arguments: {} })
          return (result.structuredContent as { notes: ReadonlyArray<Note> }).notes
        }),
      databasePath,
    )

    expect(notes).toHaveLength(1)
    expect(notes[0]!.id).toBe(id)
    expect(notes[0]!.title).toBe("Persisted")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
