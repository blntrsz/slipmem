import { expect, test } from "bun:test"
import { Array, Effect, Option, Schema } from "effect"
import { AsyncData, Scene, Story } from "foldkit"
import { Server } from "foldkit/experimental"
import { fromString } from "foldkit/url"

import { ApiNote } from "./api"
import {
  DeleteNote,
  EditorState,
  LoadHealth,
  LoadNote,
  LoadNotes,
  LoadPending,
  LoadSearch,
  LoadTags,
  LoadWiki,
  Message,
  Model,
  NavigateInternal,
  SaveNote,
  draftFromForm,
  formError,
  init,
  parseFormTags,
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
    tags: ["agent-memory"],
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
  tag: Option.none(),
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
    tags: AsyncData.Idle(),
    wiki: AsyncData.Idle(),
    pending: AsyncData.Idle(),
    health: AsyncData.Idle(),
    editor: EditorState.Closed(),
    deleteRequest: Option.none(),
    proposalAction: Option.none(),
    searchInput: "",
    lastError: Option.none(),
    notesRequestId: 0,
    noteRequestId: 0,
    searchRequestId: 0,
    tagsRequestId: 0,
    wikiRequestId: 0,
    pendingRequestId: 0,
    healthRequestId: 0,
    saveRequestId: 0,
    deleteRequestId: 0,
    proposalRequestId: 0,
    ...overrides,
  })

const notesOf = (model: Model): ReadonlyArray<ApiNote> =>
  AsyncData.getOrElse(model.notes, () => [])

const url = (value: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${value}`),
    () => new Error(`Invalid URL ${value}`),
  )

const cancelled = Message.CancelledRouteRead()
const resolveRouteReads = (
  ids: {
    readonly notes?: number
    readonly note?: number
    readonly search?: number
    readonly tags?: number
    readonly wiki?: number
    readonly pending?: number
    readonly health?: number
  } = {},
) => {
  const toMessage = () => cancelled
  return Story.Command.resolveAll(
    [LoadNotes.Interrupt({ requestId: ids.notes ?? 0 }, toMessage), cancelled],
    [LoadNote.Interrupt({ requestId: ids.note ?? 0 }, toMessage), cancelled],
    [LoadSearch.Interrupt({ requestId: ids.search ?? 0 }, toMessage), cancelled],
    [LoadTags.Interrupt({ requestId: ids.tags ?? 0 }, toMessage), cancelled],
    [LoadWiki.Interrupt({ requestId: ids.wiki ?? 0 }, toMessage), cancelled],
    [LoadPending.Interrupt({ requestId: ids.pending ?? 0 }, toMessage), cancelled],
    [LoadHealth.Interrupt({ requestId: ids.health ?? 0 }, toMessage), cancelled],
  )
}

const interruptKey = (command: unknown): string | undefined => {
  if (typeof command !== "object" || command === null) {
    return undefined
  }
  const key = (command as { readonly interruptsKey?: unknown }).interruptsKey
  return typeof key === "string" ? key : undefined
}

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

  const tags = init(url("/tags"))
  expect(Array.map(tags.commands ?? [], (command) => command.name)).toEqual([
    "LoadTags",
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
    resolveRouteReads(),
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
      expect(editor.form.tags).toBe("agent-memory")
    }),
    Story.Command.expectNone(),
  )
})

test("a failed edit load shows the error and a retry action", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.EditNote({ noteId: permanent.id }), {
        note: AsyncData.Failure({ error: "Could not load the note." }),
      }),
    ),
    Scene.expect(Scene.text("Could not load the note.")).toExist(),
    Scene.expect(Scene.role("button", { name: "Retry" })).toExist(),
    Scene.expect(Scene.text("Loading note...")).toBeAbsent(),
  )
})

test("the editor validates content limits, references, and tags locally", () => {
  expect(
    formError("fleeting", {
      title: " ",
      content: "body",
      reference: "",
      tags: "",
    }),
  ).toEqual(Option.some("Title is required."))

  expect(
    formError("fleeting", {
      title: "Title",
      content: "a".repeat(1001),
      reference: "",
      tags: "",
    }),
  ).toEqual(Option.some("fleeting notes are limited to 1000 characters."))

  expect(
    formError("literature", {
      title: "Title",
      content: "body",
      reference: "",
      tags: "",
    }),
  ).toEqual(Option.some("Literature notes require a reference."))

  expect(
    formError("permanent", {
      title: "Title",
      content: "body",
      reference: "",
      tags: "日本語",
    }),
  ).toEqual(Option.some("Every tag needs at least one letter or digit."))

  expect(
    formError("permanent", {
      title: "Title",
      content: "body",
      reference: "",
      tags: "agent-memory, retrieval",
    }),
  ).toEqual(Option.none())

  expect(
    formError("permanent", {
      title: "Title",
      content: "body",
      reference: "",
      tags: "agent-memory, , retrieval, ",
    }),
  ).toEqual(Option.none())
})

test("the editor normalizes tag input once for validation and the write payload", () => {
  expect(parseFormTags(" agent-memory, retrieval, ")).toEqual([
    "agent-memory",
    "retrieval",
  ])
  expect(parseFormTags(" , , ")).toEqual([])

  expect(
    draftFromForm("permanent", {
      title: "A durable idea",
      content: "Write it down properly.",
      reference: "",
      tags: "",
    }),
  ).toEqual({
    title: "A durable idea",
    content: "Write it down properly.",
    tags: [],
  })

  expect(
    draftFromForm("literature", {
      title: "A source",
      content: "Quoted.",
      reference: "Book, chapter 2",
      tags: "agent-memory, , retrieval",
    }),
  ).toEqual({
    title: "A source",
    content: "Quoted.",
    reference: "Book, chapter 2",
    tags: ["agent-memory", "retrieval"],
  })
})

test("saving a new note takes the request id, shows saving, and navigates to the note", () => {
  Story.story(
    update,
    Story.given(
      baseModel(AppRoute.NewNote({ type: Option.some("permanent") }), {
        editor: EditorState.Open({
          type: "permanent",
          maybeId: Option.none(),
          form: { title: "", content: "", reference: "", tags: "" },
        }),
      }),
    ),
    Story.message(Message.UpdatedTitle({ value: "A durable idea" })),
    Story.message(Message.UpdatedContent({ value: "Write it down properly." })),
    Story.message(Message.UpdatedTags({ value: "agent-memory" })),
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
      expect(model.deleteRequest).toEqual(
        Option.some({ requestId: 1, noteId: fleeting.id }),
      )
    }),
    Story.Command.expectHas(DeleteNote),
    Story.Command.resolve(
      DeleteNote,
      Message.SucceededDeleteNote({ requestId: 1, noteId: fleeting.id }),
    ),
    Story.model((model) => {
      expect(notesOf(model).map((item) => item.id)).toEqual([permanent.id])
      expect(Option.isNone(AsyncData.getOrElse(model.note, () => Option.some(fleeting)))).toBe(true)
      expect(model.deleteRequest).toEqual(Option.none())
    }),
    Story.Command.expectHas(NavigateInternal),
    Story.Command.resolve(
      NavigateInternal,
      Message.CompletedNavigateInternal(),
    ),
  )
})

test("delete completion is correlated and does not navigate a changed route", () => {
  const start = baseModel(AppRoute.DeleteNote({ noteId: fleeting.id }), {
    note: AsyncData.Success({ data: Option.some(fleeting) }),
    notes: AsyncData.Success({ data: [fleeting, permanent] }),
  })
  const confirmed = update(start, Message.ConfirmedDelete())
  const duplicate = update(confirmed.model, Message.ConfirmedDelete())
  expect(duplicate.commands ?? []).toHaveLength(0)
  expect(duplicate.model.deleteRequestId).toBe(1)
  expect(duplicate.model.deleteRequest).toEqual(
    Option.some({ requestId: 1, noteId: fleeting.id }),
  )

  const wrongRequest = update(
    confirmed.model,
    Message.SucceededDeleteNote({ requestId: 99, noteId: fleeting.id }),
  )
  expect(wrongRequest.model.deleteRequest).toEqual(
    Option.some({ requestId: 1, noteId: fleeting.id }),
  )

  const failed = update(
    confirmed.model,
    Message.FailedDeleteNote({ requestId: 1, message: "Delete failed." }),
  )
  expect(failed.model.deleteRequest).toEqual(Option.none())
  expect(failed.model.lastError).toEqual(Option.some("Delete failed."))

  const navigated = update(
    confirmed.model,
    Message.ChangedUrl({ url: url("/") }),
  )
  const completed = update(
    navigated.model,
    Message.SucceededDeleteNote({ requestId: 1, noteId: fleeting.id }),
  )
  expect(completed.model.deleteRequest).toEqual(Option.none())
  expect(completed.commands ?? []).toHaveLength(0)
  expect(
    AsyncData.getOrElse(completed.model.note, () => Option.none()),
  ).toEqual(Option.some(fleeting))
})

test("refresh reloads the current route without dropping filters", () => {
  Story.story(
    update,
    Story.given(
      baseModel(
        AppRoute.Home({
          type: Option.some("permanent"),
          tag: Option.some("agent-memory"),
        }),
        {
          notes: AsyncData.Success({ data: [permanent] }),
          notesRequestId: 3,
        },
      ),
    ),
    Story.message(Message.ClickedRefresh()),
    Story.model((model) => {
      expect(model.notes._tag).toBe("Loading")
      expect(model.notesRequestId).toBe(4)
      expect(model.route).toMatchObject({
        _tag: "Home",
        type: Option.some("permanent"),
        tag: Option.some("agent-memory"),
      })
    }),
    resolveRouteReads({ notes: 3 }),
    Story.Command.expectHas(LoadNotes),
    Story.Command.resolve(
      LoadNotes,
      Message.SucceededLoadNotes({ requestId: 4, notes: [permanent] }),
    ),
    Story.model((model) => {
      expect(notesOf(model)).toHaveLength(1)
    }),
  )
})

test("the home list renders IDs, tags, and note text as escaped content", () => {
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

test("an empty search invalidates a late response from the previous query", () => {
  const hit = {
    note: permanent,
    id: permanent.id,
    path: permanent.path,
    score: 5,
  }
  const searching = baseModel(
    AppRoute.Search({ q: Option.some("recall"), type: Option.none() }),
    {
      search: AsyncData.Loading(),
      searchInput: "recall",
      searchRequestId: 1,
    },
  )

  const emptied = update(
    searching,
    Message.ChangedUrl({ url: url("/search") }),
  )

  expect(emptied.model.search._tag).toBe("Idle")
  expect(emptied.model.searchInput).toBe("")
  expect(emptied.model.searchRequestId).toBe(2)
  expect(Array.map(emptied.commands ?? [], (command) => command.name)).toContain(
    "LoadSearch.Interrupt",
  )

  const late = update(
    emptied.model,
    Message.SucceededSearch({ requestId: 1, results: [hit] }),
  )
  expect(late.model.search._tag).toBe("Idle")

  const firstQuery = update(
    emptied.model,
    Message.ChangedUrl({ url: url("/search?q=first") }),
  )
  const secondQuery = update(
    firstQuery.model,
    Message.ChangedUrl({ url: url("/search?q=second") }),
  )
  const stale = update(
    secondQuery.model,
    Message.SucceededSearch({ requestId: secondQuery.model.searchRequestId - 1, results: [hit] }),
  )
  expect(stale.model.search._tag).toBe("Loading")
})

test("navigation cancels superseded route reads before starting the next load", () => {
  const result = update(
    baseModel(homeRoute, {
      notes: AsyncData.Loading(),
      notesRequestId: 7,
      note: AsyncData.Loading(),
      noteRequestId: 3,
    }),
    Message.ChangedUrl({ url: url("/review") }),
  )
  const commands = result.commands ?? []
  const names = Array.map(commands, (command) => command.name)
  expect(names).toContain("LoadNotes.Interrupt")
  expect(names).toContain("LoadNote.Interrupt")
  expect(names).toContain("LoadPending")
  expect(names.indexOf("LoadNotes.Interrupt")).toBeLessThan(
    names.indexOf("LoadPending"),
  )
  expect(result.model.notesRequestId).toBe(7)

  // The interrupt must target the key held by the read the model is actually
  // waiting on, not a neighbouring request id. A wrong key would silently
  // leave the superseded read running.
  const notesInterrupt = commands.find(
    (command) => command.name === "LoadNotes.Interrupt",
  )
  expect(interruptKey(notesInterrupt)).toBe(
    LoadNotes({ requestId: 7, type: Option.none(), tag: Option.none() }).key,
  )
  expect(interruptKey(notesInterrupt)).not.toBe(
    LoadNotes({ requestId: 8, type: Option.none(), tag: Option.none() }).key,
  )

  const noteInterrupt = commands.find(
    (command) => command.name === "LoadNote.Interrupt",
  )
  expect(interruptKey(noteInterrupt)).toBe(
    LoadNote({ requestId: 3, noteId: permanent.id }).key,
  )
})

test("tags render counts and link to cited tag pages", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.Tags(), {
        tags: AsyncData.Success({
          data: [
            {
              tag: "agent-memory",
              noteCount: 2,
              byType: { fleeting: 1, literature: 0, permanent: 1 },
            },
          ],
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Tags" })).toExist(),
    Scene.expect(Scene.text("agent-memory")).toExist(),
    Scene.expect(Scene.text("2 notes (1 fleeting, 1 permanent)")).toExist(),
    Scene.expect(Scene.text(/Counts include every note type/)).toExist(),
    Scene.expect(Scene.role("link", { name: "Open tag page" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Include fleeting" })).toExist(),
  )
})

const notConfiguredSynthesis = {
  configured: false,
  kind: "none" as const,
  detail: "Extractive mode is the default.",
}

test("wiki sections and citations render without persisted HTML", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(
        AppRoute.Wiki({
          tag: "agent-memory",
          mode: Option.none(),
          includeFleeting: Option.none(),
        }),
        {
          wiki: AsyncData.Success({
            data: {
              tag: "agent-memory",
              generatedAt: "2026-11-17T20:10:00Z",
              mode: "extractive",
              noteCount: 1,
              synthesis: notConfiguredSynthesis,
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
              markdown: "# Tag: agent-memory\n\n> Every recall operation has a hard maximum.",
            },
          }),
        },
      ),
    ),
    Scene.expect(Scene.role("heading", { name: "Tag: agent-memory" })).toExist(),
    Scene.expect(Scene.text(/Derived on demand/)).toExist(),
    Scene.expect(Scene.text(/Permanent and literature notes are cited by default/)).toExist(),
    Scene.expect(Scene.text(/Synthesized mode is not configured/)).toExist(),
    Scene.expect(Scene.role("link", { name: "Try synthesized" })).toBeAbsent(),
    Scene.expect(Scene.role("link", { name: "Include fleeting" })).toExist(),
    Scene.expect(Scene.role("link", { name: permanent.id })).toExist(),
    Scene.expect(Scene.selector("script")).toBeAbsent(),
  )
})

test("wiki offers synthesis only when the server reports it configured", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(
        AppRoute.Wiki({
          tag: "agent-memory",
          mode: Option.none(),
          includeFleeting: Option.some("true"),
        }),
        {
          wiki: AsyncData.Success({
            data: {
              tag: "agent-memory",
              generatedAt: "2026-11-17T20:10:00Z",
              mode: "extractive",
              noteCount: 1,
              synthesis: {
                configured: true,
                kind: "agent",
                detail: "A local synthesis agent is configured.",
              },
              sources: [],
              sections: [],
              markdown: "# Tag: agent-memory",
            },
          }),
        },
      ),
    ),
    Scene.expect(Scene.role("link", { name: "Try synthesized" })).toExist(),
    Scene.expect(Scene.text(/Fleeting notes are included/)).toExist(),
    Scene.expect(Scene.role("link", { name: "Exclude fleeting" })).toExist(),
  )
})

test("a failed synthesized page keeps an extractive fallback link", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(
        AppRoute.Wiki({
          tag: "agent-memory",
          mode: Option.some("synthesized"),
          includeFleeting: Option.none(),
        }),
        {
          wiki: AsyncData.Failure({
            error: "Synthesized mode requires a configured local synthesizer.",
          }),
        },
      ),
    ),
    Scene.expect(
      Scene.text(/Synthesized mode requires a configured local synthesizer/),
    ).toExist(),
    Scene.expect(Scene.role("link", { name: "Use extractive page" })).toExist(),
    Scene.expect(Scene.role("button", { name: "Retry" })).toExist(),
  )
})

test("the new-note form offers a type selector with the route type selected", () => {
  Scene.scene(
    { update, view },
    Scene.given(
      baseModel(AppRoute.NewNote({ type: Option.some("permanent") }), {
        editor: EditorState.Open({
          type: "permanent",
          maybeId: Option.none(),
          form: { title: "", content: "", reference: "", tags: "" },
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "New permanent note" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Fleeting" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Literature" })).toExist(),
    Scene.expect(Scene.role("link", { name: "Permanent" })).toExist(),
    Scene.expect(Scene.selector("#note-title")).toHaveAccessibleName("Title"),
    Scene.expect(Scene.selector("#note-content")).toHaveAccessibleName("Content"),
  )
})

test("proposal actions are guarded, correlated, and finish by reloading the queue", () => {
  const proposalId = "proposal-20261117210000-deadbeef"
  const review = baseModel(AppRoute.Review(), {
    pending: AsyncData.Success({
      data: {
        proposals: [
          {
            id: proposalId,
            operation: "create" as const,
            noteId: permanent.id,
            path: `/notes/${permanent.id}.md`,
            summary: "Create a permanent note",
            createdAt: "2026-11-17T21:00:00Z",
            expiresAt: "2026-11-24T21:00:00Z",
            stale: false,
            expired: false,
            diff: "+title: Bounded recall",
          },
        ],
        invalid: [],
      },
    }),
    pendingRequestId: 4,
  })

  const approving = update(review, Message.ClickedApprove({ proposalId }))
  expect(approving.model.proposalAction).toEqual(
    Option.some({ requestId: 1, proposalId, action: "approve" }),
  )
  expect(Array.map(approving.commands ?? [], (command) => command.name)).toEqual([
    "ApproveProposal",
  ])

  const duplicate = update(
    approving.model,
    Message.ClickedApprove({ proposalId }),
  )
  expect(duplicate.commands ?? []).toHaveLength(0)
  const competingReject = update(
    approving.model,
    Message.ClickedReject({ proposalId }),
  )
  expect(competingReject.commands ?? []).toHaveLength(0)

  const uncorrelated = update(
    approving.model,
    Message.FailedApprove({
      requestId: 99,
      proposalId,
      message: "Wrong request.",
    }),
  )
  expect(uncorrelated.model.proposalAction).toEqual(
    Option.some({ requestId: 1, proposalId, action: "approve" }),
  )
  expect(uncorrelated.model.lastError).toEqual(Option.none())

  const failed = update(
    approving.model,
    Message.FailedApprove({
      requestId: 1,
      proposalId,
      message: "Approval failed.",
    }),
  )
  expect(failed.model.proposalAction).toEqual(Option.none())
  expect(failed.model.lastError).toEqual(Option.some("Approval failed."))

  const approved = update(
    approving.model,
    Message.SucceededApprove({ requestId: 1, proposalId }),
  )
  expect(approved.model.proposalAction).toEqual(Option.none())
  expect(approved.model.pending._tag).toBe("Loading")
  expect(approved.model.pendingRequestId).toBe(5)
  expect(Array.map(approved.commands ?? [], (command) => command.name)).toEqual([
    "LoadPending",
  ])

  const navigated = update(
    approving.model,
    Message.ChangedUrl({ url: url("/") }),
  )
  const completedAway = update(
    navigated.model,
    Message.SucceededApprove({ requestId: 1, proposalId }),
  )
  expect(completedAway.model.proposalAction).toEqual(Option.none())
  expect(completedAway.commands ?? []).toHaveLength(0)
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
            wiki: { synthesis: notConfiguredSynthesis },
          },
        }),
      }),
    ),
    Scene.expect(Scene.role("heading", { name: "Health" })).toExist(),
    Scene.expect(Scene.text("slipmem is ready")).toExist(),
    Scene.expect(Scene.text("slipmem slipmem")).toBeAbsent(),
    Scene.expect(Scene.text("/workspace/.slipmem")).toExist(),
    Scene.expect(Scene.text("fts5")).toExist(),
    Scene.expect(Scene.text("Not configured; extractive only")).toExist(),
    Scene.expect(Scene.text(/not authentication or an OS sandbox/)).toExist(),
    Scene.expect(Scene.text(/unauthenticated/)).toExist(),
  )
})
