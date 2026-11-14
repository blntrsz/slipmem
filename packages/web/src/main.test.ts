import { expect, test } from "bun:test"
import { Note } from "@slipmem/schemas/note"
import { Array, Effect, Option, Schema } from "effect"
import { AsyncData, Scene, Story } from "foldkit"
import { Server } from "foldkit/experimental"

import {
  CreateNote,
  DeleteNote,
  EditorState,
  LoadNotes,
  Message,
  Model,
  UpdateNote,
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

const permanent = decodeNote({
  type: "permanent",
  id: "permanent-1",
  title: "An evergreen idea",
  content: "Write it down properly.",
  createdAt: 1,
  updatedAt: 1,
})

const loadedModel = (
  notes: ReadonlyArray<Note.Info> = [fleeting, literature, permanent],
  overrides: Partial<Model> = {},
): Model =>
  Model.make({
    notes: AsyncData.Success({ data: notes }),
    selectedKind: "fleeting",
    editor: EditorState.Closed(),
    lastError: Option.none(),
    loadRequestId: 0,
    saveRequestId: 0,
    ...overrides,
  })

const notesFrom = (model: Model): ReadonlyArray<Note.Info> =>
  AsyncData.getOrElse(model.notes, () => [])

const noteTitles = (model: Model): ReadonlyArray<string> =>
  Array.map(notesFrom(model), (note) => note.title)

test("init starts loading notes", () => {
  const result = init()

  expect(result.model.notes._tag).toBe("Idle")
  expect(
    Array.head(result.commands ?? []).pipe(
      Option.map((command) => command.name),
    ),
  ).toEqual(Option.some("LoadNotes"))
})

test("switching note kinds changes the filter and closes the editor", () => {
  Story.story(
    update,
    Story.given(loadedModel()),
    Story.message(Message.ClickedKind({ kind: "literature" })),
    Story.model((model) => {
      expect(model.selectedKind).toBe("literature")
      expect(model.editor._tag).toBe("Closed")
    }),
    Story.Command.expectNone(),
  )
})

test("creating a note validates against the shared schema and emits a command", () => {
  const created = decodeNote({
    type: "fleeting",
    id: "fleeting-new",
    title: "New note",
    content: "Hello",
    createdAt: 4,
    updatedAt: 4,
  })

  Story.story(
    update,
    Story.given(loadedModel()),
    Story.message(Message.ClickedNewNote()),
    Story.message(Message.UpdatedTitle({ title: "New note" })),
    Story.message(Message.UpdatedContent({ content: "Hello" })),
    Story.message(Message.ClickedSavedNote()),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Saving")
    }),
    Story.Command.expectExact(CreateNote),
    Story.Command.resolve(
      CreateNote,
      Message.SucceededSaveNote({ requestId: 1, note: created }),
    ),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Closed")
      expect(model.selectedKind).toBe("fleeting")
      expect(notesFrom(model)).toContainEqual(created)
    }),
    Story.Command.expectNone(),
  )
})

test("a literature note requires a reference", () => {
  Story.story(
    update,
    Story.given(loadedModel([literature], { selectedKind: "literature" })),
    Story.message(Message.ClickedNewNote()),
    Story.message(Message.UpdatedTitle({ title: "Source" })),
    Story.message(Message.UpdatedContent({ content: "Quote" })),
    Story.message(Message.ClickedSavedNote()),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Open")
      expect(Option.getOrNull(model.lastError)).toContain(
        "Reference is required for literature notes.",
      )
    }),
    Story.Command.expectNone(),
  )
})

test("the editor enforces the shared per-kind content limit", () => {
  Story.story(
    update,
    Story.given(loadedModel()),
    Story.message(Message.ClickedNewNote()),
    Story.message(Message.UpdatedTitle({ title: "Too long" })),
    Story.message(Message.UpdatedContent({ content: "a".repeat(1001) })),
    Story.message(Message.ClickedSavedNote()),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Open")
      expect(Option.getOrNull(model.lastError)).toContain(
        "Content must be 1000 characters or fewer.",
      )
    }),
    Story.Command.expectNone(),
  )
})

test("a stale load result cannot overwrite a newer request", () => {
  // Two refreshes overlap here. `update` is used directly because Story and
  // Scene intentionally stop before a new Message while a Command is pending.
  const firstRefresh = update(loadedModel(), Message.ClickedRefreshNotes())
  const secondRefresh = update(
    firstRefresh.model,
    Message.ClickedRefreshNotes(),
  )

  expect(secondRefresh.model.loadRequestId).toBe(2)
  expect(AsyncData.isRefreshing(secondRefresh.model.notes)).toBe(true)
  expect(noteTitles(secondRefresh.model)).toEqual([
    "A quick thought",
    "A source",
    "An evergreen idea",
  ])

  const stale = update(
    secondRefresh.model,
    Message.SucceededLoadNotes({ requestId: 1, notes: [permanent] }),
  )
  expect(noteTitles(stale.model)).toEqual([
    "A quick thought",
    "A source",
    "An evergreen idea",
  ])

  const latest = update(
    stale.model,
    Message.SucceededLoadNotes({ requestId: 2, notes: [literature] }),
  )
  expect(noteTitles(latest.model)).toEqual(["A source"])
})

test("a stale save result cannot close a newer editor", () => {
  const created = decodeNote({
    type: "fleeting",
    id: "fleeting-new",
    title: "Saved first",
    content: "First body",
    createdAt: 4,
    updatedAt: 4,
  })

  const opened = update(loadedModel(), Message.ClickedNewNote())
  const titled = update(
    opened.model,
    Message.UpdatedTitle({ title: "Saved first" }),
  )
  const written = update(
    titled.model,
    Message.UpdatedContent({ content: "First body" }),
  )
  const saving = update(written.model, Message.ClickedSavedNote())

  const reopened = update(saving.model, Message.ClickedNewNote())
  const retitled = update(
    reopened.model,
    Message.UpdatedTitle({ title: "Still editing" }),
  )
  const resolved = update(
    retitled.model,
    Message.SucceededSaveNote({ requestId: 1, note: created }),
  )

  expect(resolved.model.editor._tag).toBe("Open")
  expect(
    EditorState.match(resolved.model.editor, {
      Closed: () => "",
      Saving: () => "",
      Open: ({ draft }) => draft.title,
    }),
  ).toBe("Still editing")
  expect(notesFrom(resolved.model)).toContainEqual(created)
})

test("saving one kind replaces only the matching kind and id", () => {
  const sameId = "shared-id"
  const fleetingSame = decodeNote({
    type: "fleeting",
    id: sameId,
    title: "Fleeting same id",
    content: "Old",
    createdAt: 1,
    updatedAt: 1,
  })
  const literatureSame = decodeNote({
    type: "literature",
    id: sameId,
    title: "Literature same id",
    content: "Old",
    reference: "Source",
    createdAt: 1,
    updatedAt: 2,
  })
  const literatureUpdated = decodeNote({
    ...literatureSame,
    title: "Literature updated",
    updatedAt: 5,
  })

  Story.story(
    update,
    Story.given(loadedModel([fleetingSame, literatureSame])),
    Story.message(Message.ClickedEditNote({ kind: "literature", id: sameId })),
    Story.message(Message.UpdatedTitle({ title: "Literature updated" })),
    Story.message(Message.ClickedSavedNote()),
    Story.Command.resolve(
      UpdateNote,
      Message.SucceededSaveNote({ requestId: 1, note: literatureUpdated }),
    ),
    Story.model((model) => {
      expect(notesFrom(model)).toEqual([literatureUpdated, fleetingSame])
    }),
  )
})

test("deleting one kind and id leaves a note with the same id in another kind", () => {
  const sameId = "shared-id"
  const fleetingSame = decodeNote({
    type: "fleeting",
    id: sameId,
    title: "Fleeting same id",
    content: "Keep me",
    createdAt: 1,
    updatedAt: 1,
  })
  const literatureSame = decodeNote({
    type: "literature",
    id: sameId,
    title: "Literature same id",
    content: "Keep me too",
    reference: "Source",
    createdAt: 1,
    updatedAt: 2,
  })

  Story.story(
    update,
    Story.given(loadedModel([fleetingSame, literatureSame])),
    Story.message(Message.ClickedDeleteNote({ kind: "fleeting", id: sameId })),
    Story.Command.resolve(
      DeleteNote,
      Message.SucceededDeleteNote({ kind: "fleeting", id: sameId }),
    ),
    Story.model((model) => {
      expect(notesFrom(model)).toEqual([literatureSame])
    }),
  )
})

test("a failed refresh keeps data and does not duplicate the error alert", () => {
  Story.story(
    update,
    Story.given(loadedModel()),
    Story.message(Message.ClickedRefreshNotes()),
    Story.Command.resolve(
      LoadNotes({ requestId: 1 }),
      Message.FailedLoadNotes({ requestId: 1, message: "Network down" }),
    ),
    Story.model((model) => {
      expect(AsyncData.isStale(model.notes)).toBe(true)
      expect(noteTitles(model)).toHaveLength(3)
      expect(Option.isNone(model.lastError)).toBe(true)
    }),
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
  const model = loadedModel([malicious])

  const rendered = await Effect.runPromise(
    Server.renderToString(
      { init: () => ({ model }), view },
      { isHydratable: false },
    ),
  )

  expect(rendered.html).toContain("&lt;script&gt;")
  expect(rendered.html).not.toContain('<script>alert("title")</script>')
  expect(rendered.html).not.toContain('<img src=x onerror="alert(1)">')
})

test("view renders the selected kind and its notes", async () => {
  const rendered = await Effect.runPromise(
    Server.renderToString(
      { init: () => ({ model: loadedModel() }), view },
      { isHydratable: false },
    ),
  )

  expect(rendered.html).toContain("Slipmem")
  expect(rendered.html).toContain("A quick thought")
  expect(rendered.html).not.toContain("A source")
  expect(rendered.html).toContain("New note")
  expect(rendered.html).toContain("Edit")
  expect(rendered.html).toContain("Delete")
})

test("kind filters expose their selected state to assistive technology", () => {
  Scene.scene(
    { update, view },
    Scene.given(loadedModel()),
    Scene.expect(
      Scene.role("button", { name: /^Fleeting/, pressed: true }),
    ).toExist(),
    Scene.expect(
      Scene.role("button", { name: /^Literature/, pressed: false }),
    ).toExist(),
    Scene.click(Scene.role("button", { name: /^Literature/ })),
    Scene.expect(
      Scene.role("button", { name: /^Literature/, pressed: true }),
    ).toExist(),
    Scene.expect(Scene.text("A source")).toExist(),
    Scene.expect(Scene.text("A quick thought")).toBeAbsent(),
  )
})

test("the editor labels every field and keeps the list visible while refreshing", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      loadedModel([fleeting], {
        notes: AsyncData.Refreshing({ data: [fleeting] }),
      }),
    ),
    Scene.expect(Scene.text("Refreshing notes...")).toExist(),
    Scene.expect(Scene.text("A quick thought")).toExist(),
    Scene.click(Scene.role("button", { name: "New note" })),
    Scene.expect(Scene.selector("#note-title")).toHaveAccessibleName("Title"),
    Scene.expect(Scene.selector("#note-content")).toHaveAccessibleName("Content"),
  )
})

test("the literature editor associates its reference field", () => {
  Scene.scene(
    { update, view },
    Scene.given(loadedModel([literature], { selectedKind: "literature" })),
    Scene.click(Scene.role("button", { name: "New note" })),
    Scene.expect(Scene.selector("#note-title")).toHaveAccessibleName("Title"),
    Scene.expect(Scene.selector("#note-content")).toHaveAccessibleName("Content"),
    Scene.expect(Scene.selector("#note-reference")).toHaveAccessibleName(
      "Reference",
    ),
  )
})

test("the scene submits a valid draft through the form", () => {
  const created = decodeNote({
    type: "fleeting",
    id: "fleeting-new",
    title: "Captured",
    content: "A body",
    createdAt: 4,
    updatedAt: 4,
  })

  Scene.scene(
    { update, view },
    Scene.given(loadedModel()),
    Scene.click(Scene.role("button", { name: "New note" })),
    Scene.type(Scene.selector("#note-title"), "Captured"),
    Scene.type(Scene.selector("#note-content"), "A body"),
    Scene.click(Scene.role("button", { name: "Save note" })),
    Scene.Command.expectHas(CreateNote),
    Scene.Command.resolve(
      CreateNote,
      Message.SucceededSaveNote({ requestId: 1, note: created }),
    ),
    Scene.expect(Scene.text("Captured")).toExist(),
    Scene.expect(Scene.text("Saving fleeting note")).toBeAbsent(),
  )
})

test("the scene shows a schema validation error without sending a command", () => {
  Scene.scene(
    { update, view },
    Scene.given(loadedModel([], { selectedKind: "literature" })),
    Scene.click(Scene.role("button", { name: "New note" })),
    Scene.type(Scene.selector("#note-title"), "A source"),
    Scene.type(Scene.selector("#note-content"), "A quote"),
    Scene.click(Scene.role("button", { name: "Save note" })),
    Scene.expect(Scene.role("alert")).toContainText(
      "Reference is required for literature notes.",
    ),
    Scene.Command.expectNone(),
  )
})
