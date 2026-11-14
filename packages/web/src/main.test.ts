import { expect, test } from "bun:test"
import { Note } from "@slipmem/schemas/note"
import { Array, Effect, Option, Schema } from "effect"
import { Server } from "foldkit/experimental"

import {
  EditorState,
  Message,
  Model,
  NotesState,
  init,
  update,
  view,
} from "./main"

const decodeNote = (input: unknown): Note.Info =>
  Schema.decodeUnknownSync(Note.Info)(input)

const fleeting = decodeNote({
  type: "fleeting",
  id: "fleeting-1",
  title: "A quick thought",
  content: "Capture it before it goes.",
  createdAt: 1,
  updatedAt: 3,
})

const literature = decodeNote({
  type: "literature",
  id: "literature-1",
  title: "A source",
  content: "A quote from a book.",
  reference: "Book, chapter 2",
  createdAt: 1,
  updatedAt: 2,
})

const modelWithNotes = (): Model =>
  Model.make({
    notes: NotesState.Loaded({ notes: [fleeting, literature] }),
    selectedKind: "fleeting",
    editor: EditorState.Closed(),
    lastError: Option.none(),
  })

test("init starts loading notes", () => {
  const result = init()

  expect(result.model.notes._tag).toBe("Idle")
  expect(Array.head(result.commands ?? []).pipe(Option.map((command) => command.name))).toEqual(
    Option.some("LoadNotes"),
  )
})

test("switching note kinds narrows the visible list", () => {
  const model = modelWithNotes()
  const result = update(model, Message.ClickedKind({ kind: "literature" }))

  expect(result.model.selectedKind).toBe("literature")
  expect(result.model.editor._tag).toBe("Closed")
})

test("creating a note moves the editor into saving and emits a command", () => {
  const model = modelWithNotes()
  const opened = update(model, Message.ClickedNewNote())
  expect(opened.model.editor._tag).toBe("Creating")

  const titled = update(opened.model, Message.UpdatedTitle({ title: "New note" }))
  const written = update(titled.model, Message.UpdatedContent({ content: "Hello" }))
  const saved = update(written.model, Message.ClickedSavedNote())

  expect(saved.model.editor._tag).toBe("Saving")
  expect(Array.head(saved.commands ?? []).pipe(Option.map((command) => command.name))).toEqual(
    Option.some("CreateNote"),
  )
})

test("a literature note requires a reference", () => {
  const model = Model.make({
    notes: NotesState.Loaded({ notes: [literature] }),
    selectedKind: "literature",
    editor: EditorState.Closed(),
    lastError: Option.none(),
  })

  const opened = update(model, Message.ClickedNewNote())
  const titled = update(opened.model, Message.UpdatedTitle({ title: "Source" }))
  const written = update(titled.model, Message.UpdatedContent({ content: "Quote" }))
  const saved = update(written.model, Message.ClickedSavedNote())

  expect(saved.model.editor._tag).toBe("Creating")
  expect(Option.isSome(saved.model.lastError)).toBe(true)
  expect(saved.commands).toBeUndefined()
})

test("a saved note replaces an existing note with the same id", () => {
  const model = modelWithNotes()
  const updatedFleeting = decodeNote({
    ...fleeting,
    title: "Edited",
    updatedAt: 4,
  })

  const result = update(
    model,
    Message.SucceededSaveNote({ note: updatedFleeting }),
  )

  const notes = NotesState.match(result.model.notes, {
    Idle: () => [],
    Loading: () => [],
    Failed: () => [],
    Loaded: ({ notes }) => notes,
  })

  expect(notes).toHaveLength(2)
  expect(Array.findFirst(notes, (note) => note.id === fleeting.id)).toEqual(
    Option.some(updatedFleeting),
  )
})

test("view escapes note text instead of rendering markup", async () => {
  const malicious = decodeNote({
    type: "fleeting",
    id: "fleeting-xss",
    title: '<script>alert("title")</script>',
    content: '<img src=x onerror="alert(1)">',
    createdAt: 1,
    updatedAt: 1,
  })
  const model = Model.make({
    notes: NotesState.Loaded({ notes: [malicious] }),
    selectedKind: "fleeting",
    editor: EditorState.Closed(),
    lastError: Option.none(),
  })

  const rendered = await Effect.runPromise(
    Server.renderToString({ init: () => ({ model }), view }, { isHydratable: false }),
  )

  expect(rendered.html).toContain("&lt;script&gt;")
  expect(rendered.html).not.toContain('<script>alert("title")</script>')
  expect(rendered.html).not.toContain('<img src=x onerror="alert(1)">')
})

test("view renders the selected kind and its notes", async () => {
  const model = modelWithNotes()
  const rendered = await Effect.runPromise(
    Server.renderToString({ init: () => ({ model }), view }, { isHydratable: false }),
  )

  expect(rendered.html).toContain("Slipmem")
  expect(rendered.html).toContain("A quick thought")
  expect(rendered.html).not.toContain("A source")
  expect(rendered.html).toContain("New note")
  expect(rendered.html).toContain("Edit")
  expect(rendered.html).toContain("Delete")
})
