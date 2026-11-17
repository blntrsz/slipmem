import { expect, test } from "bun:test"
import { Array, Effect, Option, Schema } from "effect"
import { AsyncData, Scene, Story } from "foldkit"
import { Server } from "foldkit/experimental"
import { fromString } from "foldkit/url"

import { ApiNote } from "./api"
import {
  DeleteNote,
  EditorState,
  LoadNote,
  Message,
  Model,
  NavigateInternal,
  SaveNote,
  formError,
  init,
  update,
  view,
} from "./main"
import { AppRoute } from "./route"

const decodeNote = (input: unknown): ApiNote =>
  Schema.decodeUnknownSync(ApiNote)(input)

const note = (
  type: "fleeting" | "literature" | "permanent",
  id: string,
  title: string,
  content: string,
  overrides: Record<string, unknown> = {},
): ApiNote =>
  decodeNote({
    type,
    id,
    title,
    content,
    topics: ["agent-memory"],
    path: `/notes/${id}.md`,
    contentHash: "hash",
    createdAt: 1,
    updatedAt: 2,
    ...(type === "literature" ? { reference: "Book" } : {}),
    ...overrides,
  })

const fleeting = note(
  "fleeting",
  "20261117193045-quick-thought",
  "A quick thought",
  "Capture it before it goes.",
  { updatedAt: 3 },
)

const permanent = note(
  "permanent",
  "20261117201500-bounded-recall",
  "Bounded recall",
  "Every recall operation has a hard maximum.",
)

const literature = note(
  "literature",
  "20261117213000-a-source",
  "A source",
  "A quote from a book.",
  { reference: "Book, chapter 2" },
)

const homeRoute = AppRoute.Home({
  type: Option.none(),
  topic: Option.none(),
})

const baseModel = (
  route: AppRoute = homeRoute,
  overrides: Partial<Model> = {},
): Model =>
  Model.make({
    route,
    notes: AsyncData.Idle(),
    note: AsyncData.Idle(),
    search: AsyncData.Idle(),
    topics: AsyncData.Idle(),
    wiki: AsyncData.Idle(),
    pending: AsyncData.Idle(),
    health: AsyncData.Idle(),
    editor: EditorState.Closed(),
    searchInput: "",
    lastError: Option.none(),
    notesRequestId: 0,
    noteRequestId: 0,
    searchRequestId: 0,
    topicsRequestId: 0,
    wikiRequestId: 0,
    pendingRequestId: 0,
    healthRequestId: 0,
    saveRequestId: 0,
    deleteRequestId: 0,
    ...overrides,
  })

const notesOf = (model: Model): ReadonlyArray<ApiNote> =>
  AsyncData.getOrElse(model.notes, () => [])

const url = (value: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${value}`),
    () => new Error(`Invalid URL ${value}`),
  )

test("init enters the requested route and issues one bounded load command", () => {
  const home = init(url("/?type=permanent"))
  expect(home.model.route._tag).toBe("Home")
  expect(home.model.notes._tag).toBe("Loading")
  expect(Array.map(home.commands ?? [], (command) => command.name)).toEqual([
    "LoadNotes",
  ])

  const detail = init(url(`/notes/${permanent.id}`))
  expect(detail.model.route._tag).toBe("NoteDetail")
  expect(Array.map(detail.commands ?? [], (command) => command.name)).toEqual([
    "LoadNote",
  ])

  const edit = init(url(`/notes/${permanent.id}/edit`))
  expect(edit.model.route._tag).toBe("EditNote")
  expect(edit.model.editor._tag).toBe("Closed")

  const review = init(url("/review"))
  expect(Array.map(review.commands ?? [], (command) => command.name)).toEqual([
    "LoadPending",
  ])

  const wiki = init(url("/wiki/agent-memory?mode=synthesized"))
  expect(wiki.model.route._tag).toBe("Wiki")
  expect(Array.map(wiki.commands ?? [], (command) => command.name)).toEqual([
    "LoadWiki",
  ])

  const topics = init(url("/topics"))
  expect(Array.map(topics.commands ?? [], (command) => command.name)).toEqual([
    "LoadTopics",
  ])

  const search = init(url("/search?q=recall"))
  expect(Array.map(search.commands ?? [], (command) => command.name)).toEqual([
    "LoadSearch",
  ])

  const health = init(url("/health"))
  expect(Array.map(health.commands ?? [], (command) => command.name)).toEqual([
    "LoadHealth",
  ])

  const missing = init(url("/no/such/page"))
  expect(missing.model.route._tag).toBe("NotFound")
  expect(missing.commands ?? []).toHaveLength(0)
})

test("changing routes closes stale editors and starts the new load", () => {
  Story.story(
    update,
    Story.given(baseModel()),
    Story.message(Message.ChangedUrl({ url: url(`/notes/${permanent.id}/edit`) })),
    Story.model((model) => {
      expect(model.route._tag).toBe("EditNote")
      expect(model.editor._tag).toBe("Closed")
      expect(model.note._tag).toBe("Loading")
    }),
    Story.Command.expectHas(LoadNote),
    Story.Command.resolve(
      LoadNote,
      Message.SucceededLoadNote({ requestId: 1, note: Option.none() }),
    ),
  )
})

test("a loaded note opens the edit form with note metadata as text", () => {
  Story.story(
    update,
    Story.given(
      baseModel(AppRoute.EditNote({ noteId: literature.id }), {
        noteRequestId: 1,
      }),
    ),
    Story.message(
      Message.SucceededLoadNote({
        requestId: 1,
        note: Option.some(literature),
      }),
    ),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Open")
      const editor = model.editor as Extract<
        typeof model.editor,
        { _tag: "Open" }
      >
      expect(editor.type).toBe("literature")
      expect(editor.form.title).toBe("A source")
      expect(editor.form.reference).toBe("Book, chapter 2")
      expect(editor.form.topics).toBe("agent-memory")
    }),
    Story.Command.expectNone(),
  )
})

test("the editor validates content limits, references, and topics locally", () => {
  expect(
    formError("fleeting", {
      title: " ",
      content: "body",
      reference: "",
      topics: "",
    }),
  ).toEqual(Option.some("Title is required."))

  expect(
    formError("fleeting", {
      title: "Title",
      content: "a".repeat(1001),
      reference: "",
      topics: "",
    }),
  ).toEqual(Option.some("fleeting notes are limited to 1000 characters."))

  expect(
    formError("literature", {
      title: "Title",
      content: "body",
      reference: "",
      topics: "",
    }),
  ).toEqual(Option.some("Literature notes require a reference."))

  expect(
    formError("permanent", {
      title: "Title",
      content: "body",
      reference: "",
      topics: "日本語",
    }),
  ).toEqual(Option.some("Every topic needs at least one letter or digit."))

  expect(
    formError("permanent", {
      title: "Title",
      content: "body",
      reference: "",
      topics: "agent-memory, retrieval",
    }),
  ).toEqual(Option.none())
})

test("saving a new note takes the request id, shows saving, and navigates to the note", () => {
  Story.story(
    update,
    Story.given(
      baseModel(AppRoute.NewNote({ type: Option.some("permanent") }), {
        editor: EditorState.Open({
          type: "permanent",
          maybeId: Option.none(),
          form: { title: "", content: "", reference: "", topics: "" },
        }),
      }),
    ),
    Story.message(Message.UpdatedTitle({ value: "A durable idea" })),
    Story.message(Message.UpdatedContent({ value: "Write it down properly." })),
    Story.message(Message.UpdatedTopics({ value: "agent-memory" })),
    Story.message(Message.SubmittedEditor()),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Saving")
      expect(model.saveRequestId).toBe(1)
    }),
    Story.Command.expectHas(SaveNote),
    Story.Command.resolve(
      SaveNote,
      Message.SucceededSaveNote({ requestId: 1, note: permanent }),
    ),
    Story.model((model) => {
      expect(model.editor._tag).toBe("Closed")
      expect(Option.getOrNull(AsyncData.getOrElse(model.note, () => Option.none())))
        .toMatchObject({ id: permanent.id })
      expect(notesOf(model).map((item) => item.id)).toEqual([permanent.id])
    }),
    Story.Command.expectHas(NavigateInternal),
    Story.Command.resolve(
      NavigateInternal,
      Message.CompletedNavigateInternal(),
    ),
  )
})

test("delete requires the confirmation route, then removes the note from the list", () => {
  Story.story(
    update,
    Story.given(
      baseModel(AppRoute.DeleteNote({ noteId: fleeting.id }), {
        notes: AsyncData.Success({ data: [fleeting, permanent] }),
        note: AsyncData.Success({ data: Option.some(fleeting) }),
      }),
    ),
    Story.message(Message.ConfirmedDelete()),
    Story.model((model) => {
      expect(model.deleteRequestId).toBe(1)
    }),
    Story.Command.expectHas(DeleteNote),
    Story.Command.resolve(
      DeleteNote,
      Message.SucceededDeleteNote({ requestId: 1, noteId: fleeting.id }),
    ),
    Story.model((model) => {
      expect(notesOf(model).map((item) => item.id)).toEqual([permanent.id])
      expect(Option.isNone(AsyncData.getOrElse(model.note, () => Option.some(fleeting)))).toBe(true)
    }),
    Story.Command.expectHas(NavigateInternal),
    Story.Command.resolve(
      NavigateInternal,
      Message.CompletedNavigateInternal(),
    ),
  )
})

test("the home list renders IDs, topics, and note text as escaped content", () => {
  const dangerous = note(
    "fleeting",
    "20261117220000-injection",
    "Injection attempt",
    "<script>alert('x')</script>",
  )
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(homeRoute, {
        notes: AsyncData.Success({ data: [dangerous, permanent] }),
      }),
    ),
    Scene.expect(Scene.role("link", { name: "Injection attempt" })).toExist(),
    Scene.expect(Scene.text("Bounded recall")).toExist(),
    Scene.expect(Scene.role("link", { name: "agent-memory" })).toExist(),
    Scene.expect(Scene.selector("script")).toBeAbsent(),
  )
})

test("the detail view is ID-based and renders the full note as text", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.NoteDetail({ noteId: permanent.id }), {
        note: AsyncData.Success({ data: Option.some(permanent) }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Bounded recall" })).toExist(),
    Scene.expect(Scene.text("Every recall operation has a hard maximum.")).toExist(),
    Scene.expect(Scene.text(permanent.id)).toExist(),
    Scene.expect(Scene.text(permanent.path)).toExist(),
    Scene.expect(Scene.role("link", { name: "Edit" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Delete" })).toExist(),
  )
})

test("the delete confirmation names the note and warns about the backup move", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.DeleteNote({ noteId: permanent.id }), {
        note: AsyncData.Success({ data: Option.some(permanent) }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Delete this note?" })).toExist(),
    Scene.expect(Scene.text(/moved out of the note root/)).toExist(),
    Scene.expect(Scene.role("button", { name: "Delete note" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Cancel" })).toExist(),
  )
})

test("search results render the note ID, path, and excerpt", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.Search({ q: Option.some("recall"), type: Option.none() }), {
        search: AsyncData.Success({
          data: [
            {
              note: permanent,
              id: permanent.id,
              path: permanent.path,
              score: 5,
            },
          ],
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Search" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Bounded recall" })).toExist(),
    Scene.expect(Scene.text(`ID ${permanent.id}`)).toExist(),
    Scene.expect(Scene.text(permanent.path)).toExist(),
  )
})

test("topics render counts and link to cited topic pages", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.Topics(), {
        topics: AsyncData.Success({
          data: [{ topic: "agent-memory", noteCount: 2 }],
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Topics" })).toExist(),
    Scene.expect(Scene.text("agent-memory")).toExist(),
    Scene.expect(Scene.text("2 notes")).toExist(),
    Scene.expect(Scene.role("link", { name: "Open topic page" })).toExist(),
  )
})

test("wiki sections and citations render without persisted HTML", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(
        AppRoute.Wiki({ topic: "agent-memory", mode: Option.none() }),
        {
          wiki: AsyncData.Success({
            data: {
              topic: "agent-memory",
              generatedAt: "2026-11-17T20:10:00Z",
              mode: "extractive",
              noteCount: 1,
              sources: [
                {
                  id: permanent.id as never,
                  path: permanent.path,
                  type: "permanent",
                  title: permanent.title,
                  updatedAt: "2026-11-17T19:35:02Z",
                },
              ],
              sections: [
                {
                  heading: "Bounded recall",
                  markdown: "> Every recall operation has a hard maximum.",
                  citations: [
                    {
                      noteId: permanent.id as never,
                      path: permanent.path,
                      excerpt: "Every recall operation has a hard maximum.",
                    },
                  ],
                },
              ],
              markdown: "# Topic: agent-memory\n\n> Every recall operation has a hard maximum.",
            },
          }),
        },
      ),
    ),
    Scene.expect(Scene.role("heading", { name: "Topic: agent-memory" })).toExist(),
    Scene.expect(Scene.text(/Derived on demand/)).toExist(),
    Scene.expect(Scene.role("link", { name: permanent.id })).toExist(),
    Scene.expect(Scene.selector("script")).toBeAbsent(),
  )
})

test("the review queue shows an inspectable diff and approve/reject controls", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.Review(), {
        pending: AsyncData.Success({
          data: {
            proposals: [
              {
                id: "proposal-20261117210000-deadbeef",
                operation: "create",
                noteId: permanent.id,
                path: `/notes/${permanent.id}.md`,
                summary: "Create a permanent note",
                createdAt: "2026-11-17T21:00:00Z",
                expiresAt: "2026-11-24T21:00:00Z",
                actor: "agent-test",
                stale: false,
                expired: false,
                diff: "+title: Bounded recall\n+Every recall operation has a hard maximum.",
              },
            ],
            invalid: [],
          },
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Review" })).toExist(),
    Scene.expect(Scene.text("Create a permanent note")).toExist(),
    Scene.expect(Scene.role("button", { name: "Approve" })).toExist(),
    Scene.expect(Scene.role("button", { name: "Reject" })).toExist(),
    Scene.expect(Scene.text("+title: Bounded recall")).toExist(),
  )
})

test("the server renders the route shell before browser commands run", () => {
  const rendered = Effect.runSync(
    Server.renderToString(
      { routing: {}, init, view },
      { url: `http://localhost/notes/${permanent.id}`, isHydratable: false },
    ),
  )

  expect(rendered.html).toContain("Slipmem")
  expect(rendered.html).toContain("Loading note...")
})

test("health reports the Markdown root and the local security posture", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.Health(), {
        health: AsyncData.Success({
          data: {
            ok: true,
            service: "slipmem",
            noteRoot: "/workspace/.slipmem",
            index: {
              mode: "fts5",
              path: "/home/user/.cache/slipmem/index/index.sqlite",
              noteCount: 3,
            },
          },
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Health" })).toExist(),
    Scene.expect(Scene.text("/workspace/.slipmem")).toExist(),
    Scene.expect(Scene.text("fts5")).toExist(),
    Scene.expect(Scene.text(/unauthenticated/)).toExist(),
  )
})
