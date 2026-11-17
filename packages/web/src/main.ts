import { Markdown } from "@slipmem/schemas/markdown"
import { Array, Effect, Match, Option, Order, Schema } from "effect"
import { AsyncData, Command, Http, Runtime, type Update } from "foldkit"
import { type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { UrlRequest, load, pushUrl } from "foldkit/navigation"
import { Url, toString as urlToString } from "foldkit/url"

import {
  ApiError,
  ApiHealth,
  ApiNote,
  ApiPendingProposal,
  ApiSearchHit,
  ApiTopic,
  apiErrorMessage,
  approveProposal,
  createNote,
  deleteNote,
  getHealth,
  getNote,
  getWiki,
  listNotes,
  listPending,
  listTopics,
  rejectProposal,
  searchNotes,
  updateNote,
  type NoteDraft,
  type NoteType,
} from "./api"
import {
  AppRoute,
  deleteNoteHref,
  editNoteHref,
  homeRouter,
  newNoteHref,
  noteHref,
  reviewRouter,
  searchHref,
  topicsRouter,
  urlToAppRoute,
  wikiHref,
} from "./route"

// MODEL

export const NotesData = AsyncData.Schema(Schema.Array(ApiNote), Schema.String)
export const NoteData = AsyncData.Schema(
  Schema.Option(ApiNote),
  Schema.String,
)
export const SearchData = AsyncData.Schema(
  Schema.Array(ApiSearchHit),
  Schema.String,
)
export const TopicsData = AsyncData.Schema(
  Schema.Array(ApiTopic),
  Schema.String,
)
export const WikiData = AsyncData.Schema(Markdown.WikiPage, Schema.String)
export const PendingData = AsyncData.Schema(
  Schema.Struct({
    proposals: Schema.Array(ApiPendingProposal),
    invalid: Schema.Array(
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ),
  }),
  Schema.String,
)
export const HealthData = AsyncData.Schema(ApiHealth, Schema.String)

export const NoteForm = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.String,
  topics: Schema.String,
})
export type NoteForm = typeof NoteForm.Type

const emptyForm: NoteForm = {
  title: "",
  content: "",
  reference: "",
  topics: "",
}

export const EditorState = defineTaggedUnion({
  Closed: {},
  Open: {
    type: Markdown.NoteType,
    maybeId: Schema.Option(Schema.String),
    form: NoteForm,
  },
  Saving: {
    requestId: Schema.Int,
    type: Markdown.NoteType,
    maybeId: Schema.Option(Schema.String),
    form: NoteForm,
  },
})
export type EditorState = typeof EditorState.Type

export const Model = Schema.Struct({
  route: AppRoute,
  notes: NotesData.schema,
  note: NoteData.schema,
  search: SearchData.schema,
  topics: TopicsData.schema,
  wiki: WikiData.schema,
  pending: PendingData.schema,
  health: HealthData.schema,
  editor: EditorState,
  searchInput: Schema.String,
  lastError: Schema.Option(Schema.String),
  notesRequestId: Schema.Int,
  noteRequestId: Schema.Int,
  searchRequestId: Schema.Int,
  topicsRequestId: Schema.Int,
  wikiRequestId: Schema.Int,
  pendingRequestId: Schema.Int,
  healthRequestId: Schema.Int,
  saveRequestId: Schema.Int,
  deleteRequestId: Schema.Int,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  ClickedRefresh: {},
  ClickedNewNote: { type: Schema.Option(Schema.String) },
  ClickedSearch: {},
  ClickedTopics: {},
  ClickedReview: {},
  ClickedWiki: { topic: Schema.String },
  UpdatedSearchInput: { value: Schema.String },
  SubmittedSearch: {},
  UpdatedTitle: { value: Schema.String },
  UpdatedContent: { value: Schema.String },
  UpdatedReference: { value: Schema.String },
  UpdatedTopics: { value: Schema.String },
  SubmittedEditor: {},
  CancelledEditor: {},
  ConfirmedDelete: {},
  ClickedApprove: { proposalId: Schema.String },
  ClickedReject: { proposalId: Schema.String },

  SucceededLoadNotes: { requestId: Schema.Int, notes: Schema.Array(ApiNote) },
  FailedLoadNotes: { requestId: Schema.Int, message: Schema.String },
  SucceededLoadNote: {
    requestId: Schema.Int,
    note: Schema.Option(ApiNote),
  },
  FailedLoadNote: { requestId: Schema.Int, message: Schema.String },
  SucceededSaveNote: { requestId: Schema.Int, note: ApiNote },
  FailedSaveNote: { requestId: Schema.Int, message: Schema.String },
  SucceededDeleteNote: { requestId: Schema.Int, noteId: Schema.String },
  FailedDeleteNote: { requestId: Schema.Int, message: Schema.String },
  SucceededSearch: {
    requestId: Schema.Int,
    results: Schema.Array(ApiSearchHit),
  },
  FailedSearch: { requestId: Schema.Int, message: Schema.String },
  SucceededTopics: { requestId: Schema.Int, topics: Schema.Array(ApiTopic) },
  FailedTopics: { requestId: Schema.Int, message: Schema.String },
  SucceededWiki: {
    requestId: Schema.Int,
    wiki: Markdown.WikiPage,
  },
  FailedWiki: { requestId: Schema.Int, message: Schema.String },
  SucceededPending: {
    requestId: Schema.Int,
    proposals: Schema.Array(ApiPendingProposal),
    invalid: Schema.Array(
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ),
  },
  FailedPending: { requestId: Schema.Int, message: Schema.String },
  SucceededHealth: { requestId: Schema.Int, health: ApiHealth },
  FailedHealth: { requestId: Schema.Int, message: Schema.String },
  SucceededApprove: { requestId: Schema.Int, proposalId: Schema.String },
  FailedApprove: { message: Schema.String },
  SucceededReject: { requestId: Schema.Int, proposalId: Schema.String },
  FailedReject: { message: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const failureMessage = (error: unknown, fallback: string): string =>
  apiErrorMessage(error, fallback)

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

export const LoadNotes = Command.define("LoadNotes", {
  args: {
    requestId: Schema.Int,
    type: Schema.Option(Markdown.NoteType),
    topic: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededLoadNotes, Message.FailedLoadNotes],
  execute: ({ requestId, type, topic }) =>
    listNotes({
      ...(Option.isSome(type) ? { type: type.value } : {}),
      ...(Option.isSome(topic) ? { topic: topic.value } : {}),
    }).pipe(
      Effect.map((notes) => Message.SucceededLoadNotes({ requestId, notes })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadNotes({
            requestId,
            message: failureMessage(error, "Could not load notes."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadNote = Command.define("LoadNote", {
  args: { requestId: Schema.Int, noteId: Schema.String },
  messages: [Message.SucceededLoadNote, Message.FailedLoadNote],
  execute: ({ requestId, noteId }) =>
    getNote(noteId).pipe(
      Effect.map((note) =>
        Message.SucceededLoadNote({
          requestId,
          note: Option.some(note),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof ApiError && error.status === 404
            ? Message.SucceededLoadNote({ requestId, note: Option.none() })
            : Message.FailedLoadNote({
                requestId,
                message: failureMessage(error, "Could not load the note."),
              }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const SaveNote = Command.define("SaveNote", {
  args: {
    requestId: Schema.Int,
    noteId: Schema.Option(Schema.String),
    type: Markdown.NoteType,
    form: NoteForm,
  },
  messages: [Message.SucceededSaveNote, Message.FailedSaveNote],
  execute: ({ requestId, noteId, type, form }) => {
    const draft: NoteDraft = {
      title: form.title,
      content: form.content,
      ...(type === "literature" ? { reference: form.reference } : {}),
      ...(form.topics.trim() === ""
        ? {}
        : { topics: form.topics.split(",").map((topic) => topic.trim()) }),
    }

    const save = Option.match(noteId, {
      onNone: () => createNote(type, draft),
      onSome: (id) => updateNote(id, draft),
    })

    return save.pipe(
      Effect.map((note) => Message.SucceededSaveNote({ requestId, note })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveNote({
            requestId,
            message: failureMessage(error, "Could not save the note."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    )
  },
})

export const DeleteNote = Command.define("DeleteNote", {
  args: { requestId: Schema.Int, noteId: Schema.String },
  messages: [Message.SucceededDeleteNote, Message.FailedDeleteNote],
  execute: ({ requestId, noteId }) =>
    deleteNote(noteId).pipe(
      Effect.map(() => Message.SucceededDeleteNote({ requestId, noteId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteNote({
            requestId,
            message: failureMessage(error, "Could not delete the note."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadSearch = Command.define("LoadSearch", {
  args: {
    requestId: Schema.Int,
    query: Schema.String,
    type: Schema.Option(Markdown.NoteType),
  },
  messages: [Message.SucceededSearch, Message.FailedSearch],
  execute: ({ requestId, query, type }) =>
    searchNotes({
      query,
      ...(Option.isSome(type) ? { type: type.value } : {}),
    }).pipe(
      Effect.map((results) => Message.SucceededSearch({ requestId, results })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSearch({
            requestId,
            message: failureMessage(error, "Could not search notes."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadTopics = Command.define("LoadTopics", {
  args: { requestId: Schema.Int },
  messages: [Message.SucceededTopics, Message.FailedTopics],
  execute: ({ requestId }) =>
    listTopics().pipe(
      Effect.map((topics) => Message.SucceededTopics({ requestId, topics })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedTopics({
            requestId,
            message: failureMessage(error, "Could not load topics."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadWiki = Command.define("LoadWiki", {
  args: {
    requestId: Schema.Int,
    topic: Schema.String,
    mode: Schema.Option(Markdown.WikiMode),
  },
  messages: [Message.SucceededWiki, Message.FailedWiki],
  execute: ({ requestId, topic, mode }) =>
    getWiki(topic, Option.isSome(mode) ? { mode: mode.value } : {}).pipe(
      Effect.map((wiki) => Message.SucceededWiki({ requestId, wiki })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedWiki({
            requestId,
            message: failureMessage(error, "Could not build the topic page."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadPending = Command.define("LoadPending", {
  args: { requestId: Schema.Int },
  messages: [Message.SucceededPending, Message.FailedPending],
  execute: ({ requestId }) =>
    listPending().pipe(
      Effect.map(({ proposals, invalid }) =>
        Message.SucceededPending({ requestId, proposals, invalid }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedPending({
            requestId,
            message: failureMessage(error, "Could not load pending proposals."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const LoadHealth = Command.define("LoadHealth", {
  args: { requestId: Schema.Int },
  messages: [Message.SucceededHealth, Message.FailedHealth],
  execute: ({ requestId }) =>
    getHealth().pipe(
      Effect.map((health) => Message.SucceededHealth({ requestId, health })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedHealth({
            requestId,
            message: failureMessage(error, "Could not read server health."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const ApproveProposal = Command.define("ApproveProposal", {
  args: { requestId: Schema.Int, proposalId: Schema.String },
  messages: [Message.SucceededApprove, Message.FailedApprove],
  execute: ({ requestId, proposalId }) =>
    approveProposal(proposalId).pipe(
      Effect.map(() => Message.SucceededApprove({ requestId, proposalId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedApprove({
            message: failureMessage(error, "Could not approve the proposal."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const RejectProposal = Command.define("RejectProposal", {
  args: { requestId: Schema.Int, proposalId: Schema.String },
  messages: [Message.SucceededReject, Message.FailedReject],
  execute: ({ requestId, proposalId }) =>
    rejectProposal(proposalId).pipe(
      Effect.map(() => Message.SucceededReject({ requestId, proposalId })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedReject({
            message: failureMessage(error, "Could not reject the proposal."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

// INIT

const emptyModel = (route: AppRoute): Model => ({
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
})

const typeFromQuery = (value: Option.Option<string>): Markdown.NoteType =>
  Option.match(value, {
    onNone: () => "fleeting",
    onSome: (candidate) =>
      Match.value(candidate).pipe(
        Match.when("literature", () => "literature" as const),
        Match.when("permanent", () => "permanent" as const),
        Match.when("fleeting", () => "fleeting" as const),
        Match.orElse(() => "fleeting" as const),
      ),
  })

const wikiModeFromQuery = (
  value: Option.Option<string>,
): Option.Option<Markdown.WikiMode> =>
  Option.flatMap(value, (mode) =>
    Match.value(mode).pipe(
      Match.when("extractive", () => Option.some("extractive" as const)),
      Match.when("synthesized", () => Option.some("synthesized" as const)),
      Match.orElse(() => Option.none<Markdown.WikiMode>()),
    ),
  )

const editorForRoute = (route: AppRoute): EditorState =>
  AppRoute.match(route, {
    NewNote: ({ type }) =>
      EditorState.Open({
        type: typeFromQuery(type),
        maybeId: Option.none(),
        form: emptyForm,
      }),
    Home: () => EditorState.Closed(),
    NoteDetail: () => EditorState.Closed(),
    EditNote: () => EditorState.Closed(),
    DeleteNote: () => EditorState.Closed(),
    Search: () => EditorState.Closed(),
    Topics: () => EditorState.Closed(),
    Wiki: () => EditorState.Closed(),
    Review: () => EditorState.Closed(),
    Health: () => EditorState.Closed(),
    NotFound: () => EditorState.Closed(),
  })

type UpdateReturn = Update.Return<Model, Message>

const enterRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const base = modifyFields(model, {
    route: () => route,
    editor: () => editorForRoute(route),
    lastError: () => Option.none(),
  })

  return AppRoute.match(route, {
    Home: ({ type, topic }) => {
      const requestId = model.notesRequestId + 1
      const kind = Option.flatMap(type, (candidate) =>
        Match.value(candidate).pipe(
          Match.when("fleeting", () => Option.some("fleeting" as const)),
          Match.when("permanent", () => Option.some("permanent" as const)),
          Match.when("literature", () => Option.some("literature" as const)),
          Match.orElse(() => Option.none<Markdown.NoteType>()),
        ),
      )
      return {
        model: modifyFields(base, {
          notes: () => AsyncData.Loading(),
          notesRequestId: () => requestId,
        }),
        commands: [LoadNotes({ requestId, type: kind, topic })],
      }
    },
    NewNote: () => ({ model: base }),
    NoteDetail: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return {
        model: modifyFields(base, {
          note: () => AsyncData.Loading(),
          noteRequestId: () => requestId,
        }),
        commands: [LoadNote({ requestId, noteId })],
      }
    },
    EditNote: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return {
        model: modifyFields(base, {
          note: () => AsyncData.Loading(),
          noteRequestId: () => requestId,
        }),
        commands: [LoadNote({ requestId, noteId })],
      }
    },
    DeleteNote: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return {
        model: modifyFields(base, {
          note: () => AsyncData.Loading(),
          noteRequestId: () => requestId,
        }),
        commands: [LoadNote({ requestId, noteId })],
      }
    },
    Search: ({ q, type }) => {
      const query = Option.getOrElse(q, () => "")
      const kind = Option.flatMap(type, (candidate) =>
        Match.value(candidate).pipe(
          Match.when("fleeting", () => Option.some("fleeting" as const)),
          Match.when("permanent", () => Option.some("permanent" as const)),
          Match.when("literature", () => Option.some("literature" as const)),
          Match.orElse(() => Option.none<Markdown.NoteType>()),
        ),
      )
      if (query.trim() === "") {
        return {
          model: modifyFields(base, {
            search: () => AsyncData.Idle(),
            searchInput: () => "",
          }),
        }
      }
      const requestId = model.searchRequestId + 1
      return {
        model: modifyFields(base, {
          search: () => AsyncData.Loading(),
          searchInput: () => query,
          searchRequestId: () => requestId,
        }),
        commands: [LoadSearch({ requestId, query, type: kind })],
      }
    },
    Topics: () => {
      const requestId = model.topicsRequestId + 1
      return {
        model: modifyFields(base, {
          topics: () => AsyncData.Loading(),
          topicsRequestId: () => requestId,
        }),
        commands: [LoadTopics({ requestId })],
      }
    },
    Wiki: ({ topic, mode }) => {
      const requestId = model.wikiRequestId + 1
      return {
        model: modifyFields(base, {
          wiki: () => AsyncData.Loading(),
          wikiRequestId: () => requestId,
        }),
        commands: [
          LoadWiki({ requestId, topic, mode: wikiModeFromQuery(mode) }),
        ],
      }
    },
    Review: () => {
      const requestId = model.pendingRequestId + 1
      return {
        model: modifyFields(base, {
          pending: () => AsyncData.Loading(),
          pendingRequestId: () => requestId,
        }),
        commands: [LoadPending({ requestId })],
      }
    },
    Health: () => {
      const requestId = model.healthRequestId + 1
      return {
        model: modifyFields(base, {
          health: () => AsyncData.Loading(),
          healthRequestId: () => requestId,
        }),
        commands: [LoadHealth({ requestId })],
      }
    },
    NotFound: () => ({ model: base }),
  })
}

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const route = urlToAppRoute(url)
  const result = enterRoute(emptyModel(route), route)
  return {
    model: result.model,
    commands: result.commands,
  }
}

// UPDATE

const withForm = (editor: EditorState, change: Partial<NoteForm>): EditorState =>
  EditorState.match(editor, {
    Closed: () => editor,
    Open: ({ type, maybeId, form }) =>
      EditorState.Open({ type, maybeId, form: { ...form, ...change } }),
    Saving: ({ requestId, type, maybeId, form }) =>
      EditorState.Saving({
        requestId,
        type,
        maybeId,
        form: { ...form, ...change },
      }),
  })

export const formError = (type: NoteType, form: NoteForm): Option.Option<string> => {
  if (form.title.trim() === "") {
    return Option.some("Title is required.")
  }
  if (form.content.trim() === "") {
    return Option.some("Content is required.")
  }
  const limit = Markdown.CONTENT_LIMITS[type]
  if (form.content.length > limit) {
    return Option.some(`${type} notes are limited to ${limit} characters.`)
  }
  if (type === "literature" && form.reference.trim() === "") {
    return Option.some("Literature notes require a reference.")
  }
  const topics = form.topics
    .split(",")
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0)
  if (topics.some((topic) => Markdown.slugifyTopic(topic) === "")) {
    return Option.some("Every topic needs at least one letter or digit.")
  }
  return Option.none()
}

const submitEditor = (model: Model): UpdateReturn =>
  EditorState.match<UpdateReturn>(model.editor, {
    Closed: () => ({ model }),
    Saving: () => ({ model }),
    Open: ({ type, maybeId, form }) => {
      const maybeError = formError(type, form)
      if (Option.isSome(maybeError)) {
        return {
          model: modifyFields(model, {
            lastError: () => maybeError,
          }),
        }
      }

      const requestId = model.saveRequestId + 1
      return {
        model: modifyFields(model, {
          editor: () => EditorState.Saving({ requestId, type, maybeId, form }),
          saveRequestId: () => requestId,
          lastError: () => Option.none(),
        }),
        commands: [SaveNote({ requestId, noteId: maybeId, type, form })],
      }
    },
  })

const byNewest = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (note: ApiNote) => note.updatedAt),
  Order.mapInput(Order.String, (note: ApiNote) => note.id),
)

const sortNotes = (notes: ReadonlyArray<ApiNote>) => Array.sort(notes, byNewest)

const refreshNotes = (model: Model, update: (notes: ReadonlyArray<ApiNote>) => ReadonlyArray<ApiNote>) => {
  const data = AsyncData.getData(model.notes)
  return Option.match(data, {
    onNone: () => model.notes,
    onSome: (notes) => AsyncData.Success({ data: update(notes) }),
  })
}

const noteFormFromNote = (note: ApiNote): NoteForm => ({
  title: note.title,
  content: note.content,
  reference: note.type === "literature" ? note.reference : "",
  topics: note.topics.join(", "),
})

const reloadForRoute = (model: Model): Update.Commands<Message> | undefined =>
  AppRoute.match(model.route, {
    Home: () => [NavigateInternal({ url: homeRouter({
      type: Option.none(),
      topic: Option.none(),
    }) })],
    Review: () => {
      const requestId = model.pendingRequestId + 1
      return [LoadPending({ requestId })]
    },
    Topics: () => {
      const requestId = model.topicsRequestId + 1
      return [LoadTopics({ requestId })]
    },
    NoteDetail: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return [LoadNote({ requestId, noteId })]
    },
    EditNote: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return [LoadNote({ requestId, noteId })]
    },
    DeleteNote: ({ noteId }) => {
      const requestId = model.noteRequestId + 1
      return [LoadNote({ requestId, noteId })]
    },
    NewNote: () => undefined,
    Search: () => undefined,
    Wiki: () => undefined,
    Health: () => {
      const requestId = model.healthRequestId + 1
      return [LoadHealth({ requestId })]
    },
    NotFound: () => undefined,
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    ChangedUrl: ({ url }) => {
      const nextRoute = urlToAppRoute(url)
      return enterRoute(model, nextRoute)
    },

    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    ClickedRefresh: () => {
      const commands = reloadForRoute(model)
      return commands === undefined ? { model } : { model, commands }
    },

    ClickedNewNote: ({ type }) => ({
      model,
      commands: [
        NavigateInternal({
          url: newNoteHref(Option.getOrNull(type) ?? undefined),
        }),
      ],
    }),

    ClickedSearch: () => ({
      model,
      commands: [NavigateInternal({ url: "/search" })],
    }),

    ClickedTopics: () => ({
      model,
      commands: [NavigateInternal({ url: topicsRouter() })],
    }),

    ClickedReview: () => ({
      model,
      commands: [NavigateInternal({ url: reviewRouter() })],
    }),

    ClickedWiki: ({ topic }) => ({
      model,
      commands: [NavigateInternal({ url: wikiHref(topic) })],
    }),

    UpdatedSearchInput: ({ value }) => ({
      model: modifyFields(model, { searchInput: () => value }),
    }),

    SubmittedSearch: () => ({
      model,
      commands: [
        NavigateInternal({
          url:
            model.searchInput.trim() === ""
              ? "/search"
              : searchHref(model.searchInput.trim()),
        }),
      ],
    }),

    UpdatedTitle: ({ value }) => ({
      model: modifyFields(model, { editor: () => withForm(model.editor, { title: value }) }),
    }),

    UpdatedContent: ({ value }) => ({
      model: modifyFields(model, { editor: () => withForm(model.editor, { content: value }) }),
    }),

    UpdatedReference: ({ value }) => ({
      model: modifyFields(model, {
        editor: () => withForm(model.editor, { reference: value }),
      }),
    }),

    UpdatedTopics: ({ value }) => ({
      model: modifyFields(model, { editor: () => withForm(model.editor, { topics: value }) }),
    }),

    SubmittedEditor: () => submitEditor(model),

    CancelledEditor: () =>
      EditorState.match<UpdateReturn>(model.editor, {
        Closed: () => ({ model }),
        Open: ({ maybeId }) => ({
          model,
          commands: [
            NavigateInternal({
              url: Option.match(maybeId, {
                onNone: () => homeRouter({ type: Option.none(), topic: Option.none() }),
                onSome: (id) => noteHref(id),
              }),
            }),
          ],
        }),
        Saving: () => ({ model }),
      }),

    ConfirmedDelete: () =>
      AppRoute.match<UpdateReturn>(model.route, {
        DeleteNote: ({ noteId }) => {
          const requestId = model.deleteRequestId + 1
          return {
            model: modifyFields(model, { deleteRequestId: () => requestId }),
            commands: [DeleteNote({ requestId, noteId })],
          }
        },
        Home: () => ({ model }),
        NewNote: () => ({ model }),
        NoteDetail: () => ({ model }),
        EditNote: () => ({ model }),
        Search: () => ({ model }),
        Topics: () => ({ model }),
        Wiki: () => ({ model }),
        Review: () => ({ model }),
        Health: () => ({ model }),
        NotFound: () => ({ model }),
      }),

    ClickedApprove: ({ proposalId }) => {
      const requestId = model.pendingRequestId + 1
      return {
        model,
        commands: [ApproveProposal({ requestId, proposalId })],
      }
    },

    ClickedReject: ({ proposalId }) => {
      const requestId = model.pendingRequestId + 1
      return {
        model,
        commands: [RejectProposal({ requestId, proposalId })],
      }
    },

    SucceededLoadNotes: ({ requestId, notes }) => {
      if (requestId !== model.notesRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          notes: () => AsyncData.Success({ data: sortNotes(notes) }),
          lastError: () => Option.none(),
        }),
      }
    },

    FailedLoadNotes: ({ requestId, message }) => {
      if (requestId !== model.notesRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          notes: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededLoadNote: ({ requestId, note }) => {
      if (requestId !== model.noteRequestId) {
        return { model }
      }
      const next = modifyFields(model, {
        note: () => AsyncData.Success({ data: note }),
        lastError: () => Option.none(),
      })
      return AppRoute.match(next.route, {
        EditNote: () =>
          Option.match(note, {
            onNone: () => ({ model: next }),
            onSome: (value) => ({
              model: modifyFields(next, {
                editor: () =>
                  EditorState.Open({
                    type: value.type,
                    maybeId: Option.some(value.id),
                    form: noteFormFromNote(value),
                  }),
              }),
            }),
          }),
        Home: () => ({ model: next }),
        NewNote: () => ({ model: next }),
        NoteDetail: () => ({ model: next }),
        DeleteNote: () => ({ model: next }),
        Search: () => ({ model: next }),
        Topics: () => ({ model: next }),
        Wiki: () => ({ model: next }),
        Review: () => ({ model: next }),
        Health: () => ({ model: next }),
        NotFound: () => ({ model: next }),
      })
    },

    FailedLoadNote: ({ requestId, message }) => {
      if (requestId !== model.noteRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          note: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededSaveNote: ({ requestId, note }) => {
      const current = EditorState.match(model.editor, {
        Saving: (saving) => saving.requestId === requestId,
        Closed: () => false,
        Open: () => false,
      })
      if (!current) {
        return { model }
      }

      const nextNotes = Option.match(AsyncData.getData(model.notes), {
        onNone: () => AsyncData.Success({ data: [note] }),
        onSome: (notes) =>
          AsyncData.Success({
            data: sortNotes([
              ...Array.filter(notes, (existing) => existing.id !== note.id),
              note,
            ]),
          }),
      })

      return {
        model: modifyFields(model, {
          editor: () => EditorState.Closed(),
          note: () => AsyncData.Success({ data: Option.some(note) }),
          notes: () => nextNotes,
          lastError: () => Option.none(),
        }),
        commands: [NavigateInternal({ url: noteHref(note.id) })],
      }
    },

    FailedSaveNote: ({ requestId, message }) => {
      const current = EditorState.match(model.editor, {
        Saving: (saving) => saving.requestId === requestId,
        Closed: () => false,
        Open: () => false,
      })
      if (!current) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          editor: () =>
            EditorState.match(model.editor, {
              Closed: () => model.editor,
              Open: () => model.editor,
              Saving: (saving) =>
                EditorState.Open({
                  type: saving.type,
                  maybeId: saving.maybeId,
                  form: saving.form,
                }),
            }),
          lastError: () => Option.some(message),
        }),
      }
    },

    SucceededDeleteNote: ({ requestId, noteId }) => {
      if (requestId !== model.deleteRequestId) {
        return { model }
      }
      const nextNotes = refreshNotes(model, (notes) =>
        Array.filter(notes, (note) => note.id !== noteId),
      )
      return {
        model: modifyFields(model, {
          notes: () => nextNotes,
          note: () => AsyncData.Success({ data: Option.none() }),
          lastError: () => Option.none(),
        }),
        commands: [
          NavigateInternal({ url: homeRouter({ type: Option.none(), topic: Option.none() }) }),
        ],
      }
    },

    FailedDeleteNote: ({ requestId, message }) => {
      if (requestId !== model.deleteRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, { lastError: () => Option.some(message) }),
      }
    },

    SucceededSearch: ({ requestId, results }) => {
      if (requestId !== model.searchRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          search: () => AsyncData.Success({ data: results }),
          lastError: () => Option.none(),
        }),
      }
    },

    FailedSearch: ({ requestId, message }) => {
      if (requestId !== model.searchRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          search: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededTopics: ({ requestId, topics }) => {
      if (requestId !== model.topicsRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          topics: () => AsyncData.Success({ data: topics }),
        }),
      }
    },

    FailedTopics: ({ requestId, message }) => {
      if (requestId !== model.topicsRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          topics: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededWiki: ({ requestId, wiki }) => {
      if (requestId !== model.wikiRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          wiki: () => AsyncData.Success({ data: wiki }),
        }),
      }
    },

    FailedWiki: ({ requestId, message }) => {
      if (requestId !== model.wikiRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          wiki: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededPending: ({ requestId, proposals, invalid }) => {
      if (requestId !== model.pendingRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          pending: () => AsyncData.Success({ data: { proposals, invalid } }),
          lastError: () => Option.none(),
        }),
      }
    },

    FailedPending: ({ requestId, message }) => {
      if (requestId !== model.pendingRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          pending: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededHealth: ({ requestId, health }) => {
      if (requestId !== model.healthRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          health: () => AsyncData.Success({ data: health }),
        }),
      }
    },

    FailedHealth: ({ requestId, message }) => {
      if (requestId !== model.healthRequestId) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          health: () => AsyncData.Failure({ error: message }),
        }),
      }
    },

    SucceededApprove: () => {
      const requestId = model.pendingRequestId + 1
      return {
        model: modifyFields(model, {
          lastError: () => Option.none(),
          pending: () => AsyncData.Loading(),
          pendingRequestId: () => requestId,
        }),
        commands: [LoadPending({ requestId })],
      }
    },

    FailedApprove: ({ message }) => ({
      model: modifyFields(model, { lastError: () => Option.some(message) }),
    }),

    SucceededReject: () => {
      const requestId = model.pendingRequestId + 1
      return {
        model: modifyFields(model, {
          lastError: () => Option.none(),
          pending: () => AsyncData.Loading(),
          pendingRequestId: () => requestId,
        }),
        commands: [LoadPending({ requestId })],
      }
    },

    FailedReject: ({ message }) => ({
      model: modifyFields(model, { lastError: () => Option.some(message) }),
    }),
  })

// SUBSCRIPTION

export const subscriptions = undefined

// VIEW

const pageClass = "min-h-screen bg-slate-950 text-slate-100"
const shellClass = "mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8"
const panelClass = "rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl"
const buttonClass =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
const primaryButtonClass =
  "rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
const dangerButtonClass =
  "rounded-lg border border-red-900 bg-red-950 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-900"
const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-400"
const linkClass = "text-emerald-300 underline-offset-4 hover:underline"
const mutedClass = "text-sm text-slate-400"
const badgeClass =
  "rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-xs uppercase tracking-wide text-emerald-300"

const kindLabels: Readonly<Record<NoteType, string>> = {
  fleeting: "Fleeting",
  literature: "Literature",
  permanent: "Permanent",
}

const formatTimestamp = (value: number): string => {
  try {
    return new Date(value).toISOString().replace(".000Z", "Z")
  } catch {
    return String(value)
  }
}

const excerptOf = (value: string, limit = 240): string =>
  value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}...`

const navLink = (
  href: string,
  label: string,
  active: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(href),
      h.Class(
        active
          ? "rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
          : "rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800",
      ),
    ],
    [label],
  )

const isRoute = (route: AppRoute, tag: string): boolean =>
  (route as { readonly _tag: string })._tag === tag

const navigation = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-4")],
        [
          h.a(
            [h.Href(homeRouter({ type: Option.none(), topic: Option.none() }))],
            [
              h.span(
                [h.Class("text-2xl font-bold tracking-tight")],
                ["Slipmem"],
              ),
            ],
          ),
          h.form(
            [
              h.Class("flex flex-1 items-center gap-2 sm:max-w-md"),
              h.OnSubmit(Message.SubmittedSearch()),
            ],
            [
              h.input([
                h.Type("search"),
                h.Class(inputClass),
                h.Value(model.searchInput),
                h.Placeholder("Search notes"),
                h.AriaLabel("Search notes"),
                h.OnInput((value) => Message.UpdatedSearchInput({ value })),
              ]),
              h.button([h.Type("submit"), h.Class(buttonClass)], ["Search"]),
            ],
          ),
        ],
      ),
      h.nav(
        [h.Class("flex flex-wrap gap-1"), h.AriaLabel("Primary")],
        [
          navLink(
            homeRouter({ type: Option.none(), topic: Option.none() }),
            "Notes",
            isRoute(model.route, "Home"),
            h,
          ),
          navLink(newNoteHref(), "New", isRoute(model.route, "NewNote"), h),
          navLink("/search", "Search", isRoute(model.route, "Search"), h),
          navLink(topicsRouter(), "Topics", isRoute(model.route, "Topics"), h),
          navLink(reviewRouter(), "Review", isRoute(model.route, "Review"), h),
          navLink("/health", "Health", isRoute(model.route, "Health"), h),
        ],
      ),
    ],
  )

const errorBanner = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.lastError, {
    onNone: () => h.empty,
    onSome: (message) =>
      h.div(
        [
          h.Class(
            "rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200",
          ),
          h.Role("alert"),
        ],
        [message],
      ),
  })

const status = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class(mutedClass), h.Role("status"), h.AriaLive("polite")], [text])

const retry = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Type("button"), h.Class(buttonClass), h.OnClick(Message.ClickedRefresh())],
    ["Retry"],
  )

const failureView = (
  message: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("flex flex-col items-start gap-3")],
    [h.p([h.Class("text-sm text-red-300")], [message]), retry(h)],
  )

const topicChips = (
  note: ApiNote,
  h: HtmlBuilder<Message>,
): Html =>
  note.topics.length === 0
    ? h.empty
    : h.ul(
        [h.Class("flex flex-wrap gap-2"), h.AriaLabel("Topics")],
        Array.map(note.topics, (topic) =>
          h.li(
            [],
            [
              h.a(
                [
                  h.Href(
                    homeRouter({
                      type: Option.none(),
                      topic: Option.some(topic),
                    }),
                  ),
                  h.Class(badgeClass),
                ],
                [topic],
              ),
            ],
          ),
        ),
      )

const noteCard = (note: ApiNote, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    note.id,
    [
      h.Class(
        "flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4",
      ),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.a(
                [h.Href(noteHref(note.id)), h.Class("text-lg font-semibold")],
                [note.title],
              ),
              h.p(
                [h.Class("flex flex-wrap items-center gap-2 text-xs text-slate-400")],
                [
                  h.span([h.Class(badgeClass)], [kindLabels[note.type]]),
                  h.span([], [`Updated ${formatTimestamp(note.updatedAt)}`]),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("flex gap-2")],
            [
              h.a(
                [h.Href(editNoteHref(note.id)), h.Class(buttonClass)],
                ["Edit"],
              ),
              h.a(
                [h.Href(deleteNoteHref(note.id)), h.Class(dangerButtonClass)],
                ["Delete"],
              ),
            ],
          ),
        ],
      ),
      h.p(
        [h.Class("whitespace-pre-wrap text-sm text-slate-300")],
        [excerptOf(note.content)],
      ),
      note.type === "literature"
        ? h.p(
            [h.Class("rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-400")],
            [`Source: ${note.reference}`],
          )
        : h.empty,
      topicChips(note, h),
    ],
  )

const notesList = (
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.match(model.notes, {
    onIdle: () => status("Loading notes...", h),
    onLoading: () => status("Loading notes...", h),
    onRefreshing: (notes) =>
      h.div(
        [h.Class("flex flex-col gap-3")],
        [status("Refreshing notes...", h), listOf(notes, h)],
      ),
    onStale: ({ data, error }) =>
      h.div(
        [h.Class("flex flex-col gap-3")],
        [
          h.p([h.Class("text-sm text-amber-300")], [error]),
          listOf(data, h),
          retry(h),
        ],
      ),
    onFailure: (error) => failureView(error, h),
    onSuccess: (notes) => listOf(notes, h),
  })

const listOf = (
  notes: ReadonlyArray<ApiNote>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(notes, {
    onEmpty: () =>
      h.p([h.Class(mutedClass)], [
        "No notes match this view yet. Create one to get started.",
      ]),
    onNonEmpty: (items) =>
      h.ul(
        [h.Class("flex flex-col gap-3")],
        Array.map(items, (note) => noteCard(note, h)),
      ),
  })

const homeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AppRoute.match(model.route, {
    Home: ({ type, topic }) => {
      const selected = Option.getOrNull(type)
      const filterLink = (label: string, value: Option.Option<string>) =>
        h.a(
          [
            h.Href(homeRouter({ type: value, topic })),
            h.Class(
              Option.getOrNull(type) === Option.getOrNull(value)
                ? "rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950"
                : "rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700",
            ),
          ],
          [label],
        )

      return h.section(
        [h.Class("flex flex-col gap-4")],
        [
          h.div(
            [h.Class("flex flex-wrap items-center justify-between gap-3")],
            [
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  h.h1([h.Class("text-3xl font-bold")], ["Notes"]),
                  Option.match(topic, {
                    onNone: () => h.p([h.Class(mutedClass)], [
                      "Every note is one Markdown file in the local note root.",
                    ]),
                    onSome: (value) =>
                      h.p([h.Class(mutedClass)], [`Topic: ${value}`]),
                  }),
                ],
              ),
              h.div(
                [h.Class("flex gap-2")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Class(buttonClass),
                      h.OnClick(Message.ClickedRefresh()),
                    ],
                    ["Refresh"],
                  ),
                  h.a(
                    [h.Href(newNoteHref(selected ?? undefined)), h.Class(primaryButtonClass)],
                    ["New note"],
                  ),
                ],
              ),
            ],
          ),
          h.nav(
            [h.Class("flex flex-wrap gap-2"), h.AriaLabel("Filter by type")],
            [
              filterLink("All", Option.none()),
              filterLink("Fleeting", Option.some("fleeting")),
              filterLink("Permanent", Option.some("permanent")),
              filterLink("Literature", Option.some("literature")),
            ],
          ),
          notesList(model, h),
        ],
      )
    },
    NewNote: () => editorView(model, h),
    NoteDetail: () => noteDetailView(model, h),
    EditNote: () => editorView(model, h),
    DeleteNote: () => deleteView(model, h),
    Search: () => searchView(model, h),
    Topics: () => topicsView(model, h),
    Wiki: () => wikiView(model, h),
    Review: () => reviewView(model, h),
    Health: () => healthView(model, h),
    NotFound: ({ path }) =>
      h.section(
        [h.Class(panelClass)],
        [
          h.h1([h.Class("text-2xl font-semibold")], ["Page not found"]),
          h.p([h.Class(mutedClass)], [`No route for /${path}.`]),
          h.a([h.Href("/"), h.Class(linkClass)], ["Back to notes"]),
        ],
      ),
  })

const field = (
  label: string,
  fieldId: string,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.For(fieldId), h.Class("flex flex-col gap-1")],
    [h.span([h.Class("text-sm font-medium text-slate-300")], [label]), control],
  )

const editorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  EditorState.match(model.editor, {
    Closed: () => {
      const maybeNote = AsyncData.getData(model.note)
      return Option.match(maybeNote, {
        onNone: () => status("Loading note...", h),
        onSome: (note) =>
          Option.match(note, {
            onNone: () =>
              h.p([h.Class(mutedClass)], ["That note does not exist."]),
            onSome: () => status("Preparing the editor...", h),
          }),
      })
    },
    Saving: ({ type, form }) =>
      h.form(
        [h.Class(panelClass), h.OnSubmit(Message.SubmittedEditor())],
        [
          h.h1(
            [h.Class("text-xl font-semibold"), h.Role("status"), h.AriaLive("polite")],
            [`Saving ${kindLabels[type].toLowerCase()} note`],
          ),
          h.p([h.Class("mt-2 text-sm text-slate-400")], [form.title]),
        ],
      ),
    Open: ({ type, maybeId, form }) => {
      const isCreating = Option.isNone(maybeId)
      const heading = isCreating
        ? `New ${kindLabels[type].toLowerCase()} note`
        : `Edit ${kindLabels[type].toLowerCase()} note`

      return h.form(
        [h.Class(panelClass), h.OnSubmit(Message.SubmittedEditor())],
        [
          h.div(
            [h.Class("mb-4 flex flex-wrap items-center justify-between gap-3")],
            [
              h.h1([h.Class("text-2xl font-semibold")], [heading]),
              h.button(
                [
                  h.Type("button"),
                  h.Class(buttonClass),
                  h.OnClick(Message.CancelledEditor()),
                ],
                ["Cancel"],
              ),
            ],
          ),
          h.div(
            [h.Class("flex flex-col gap-4")],
            [
              field(
                "Title",
                "note-title",
                h.input([
                  h.Id("note-title"),
                  h.Class(inputClass),
                  h.Value(form.title),
                  h.Required(true),
                  h.Autocomplete("off"),
                  h.OnInput((value) => Message.UpdatedTitle({ value })),
                ]),
                h,
              ),
              field(
                "Content",
                "note-content",
                h.textarea([
                  h.Id("note-content"),
                  h.Class(inputClass),
                  h.Value(form.content),
                  h.Rows(10),
                  h.Required(true),
                  h.OnInput((value) => Message.UpdatedContent({ value })),
                ]),
                h,
              ),
              type === "literature"
                ? field(
                    "Reference",
                    "note-reference",
                    h.input([
                      h.Id("note-reference"),
                      h.Class(inputClass),
                      h.Value(form.reference),
                      h.Required(true),
                      h.Autocomplete("off"),
                      h.OnInput((value) =>
                        Message.UpdatedReference({ value }),
                      ),
                    ]),
                    h,
                  )
                : h.empty,
              field(
                "Topics (comma separated)",
                "note-topics",
                h.input([
                  h.Id("note-topics"),
                  h.Class(inputClass),
                  h.Value(form.topics),
                  h.Placeholder("agent-memory, retrieval"),
                  h.Autocomplete("off"),
                  h.OnInput((value) => Message.UpdatedTopics({ value })),
                ]),
                h,
              ),
              h.button(
                [h.Type("submit"), h.Class(primaryButtonClass)],
                [isCreating ? "Create note" : "Save changes"],
              ),
            ],
          ),
        ],
      )
    },
  })

const noteMissing = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(panelClass)],
    [
      h.h1([h.Class("text-2xl font-semibold")], ["Note not found"]),
      h.p([h.Class(mutedClass)], [
        "The note may have been deleted or the ID is not a Markdown filename stem.",
      ]),
      h.a([h.Href("/"), h.Class(linkClass)], ["Back to notes"]),
    ],
  )

const noteDetailView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("flex flex-col gap-4")],
    [
      AsyncData.match(model.note, {
        onIdle: () => status("Loading note...", h),
        onLoading: () => status("Loading note...", h),
        onRefreshing: () => status("Refreshing note...", h),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (maybeNote) =>
          Option.match(maybeNote, {
            onNone: () => noteMissing(h),
            onSome: (note) =>
              h.article(
                [h.Class(panelClass)],
                [
                  h.div(
                    [h.Class("flex flex-wrap items-start justify-between gap-3")],
                    [
                      h.div(
                        [h.Class("flex flex-col gap-2")],
                        [
                          h.h1([h.Class("text-3xl font-bold")], [note.title]),
                          h.p(
                            [h.Class("flex flex-wrap items-center gap-2 text-xs text-slate-400")],
                            [
                              h.span([h.Class(badgeClass)], [kindLabels[note.type]]),
                              h.span([], [`Created ${formatTimestamp(note.createdAt)}`]),
                              h.span([], [`Updated ${formatTimestamp(note.updatedAt)}`]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("flex gap-2")],
                        [
                          h.a(
                            [h.Href(editNoteHref(note.id)), h.Class(buttonClass)],
                            ["Edit"],
                          ),
                          h.a(
                            [h.Href(deleteNoteHref(note.id)), h.Class(dangerButtonClass)],
                            ["Delete"],
                          ),
                        ],
                      ),
                    ],
                  ),
                  note.type === "literature"
                    ? h.p(
                        [h.Class("mt-4 rounded-md bg-slate-900 px-3 py-2 text-sm text-slate-300")],
                        [`Source: ${note.reference}`],
                      )
                    : h.empty,
                  h.div(
                    [h.Class("mt-4")],
                    [topicChips(note, h)],
                  ),
                  h.pre(
                    [
                      h.Class(
                        "mt-4 whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 font-sans text-sm text-slate-200",
                      ),
                    ],
                    [note.content],
                  ),
                  h.dl(
                    [h.Class("mt-6 grid gap-2 text-xs text-slate-400")],
                    [
                      h.div([], [h.dt([], ["Note ID"]), h.dd([], [note.id])]),
                      h.div([], [h.dt([], ["File"]), h.dd([h.Class("break-all")], [note.path])]),
                      h.div([], [h.dt([], ["Content hash"]), h.dd([h.Class("break-all")], [note.contentHash])]),
                    ],
                  ),
                  h.a(
                    [h.Href("/"), h.Class(`${linkClass} mt-6 inline-block`)],
                    ["Back to notes"],
                  ),
                ],
              ),
          }),
      }),
    ],
  )

const deleteView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(panelClass)],
    [
      AsyncData.match(model.note, {
        onIdle: () => status("Loading note...", h),
        onLoading: () => status("Loading note...", h),
        onRefreshing: () => status("Loading note...", h),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (maybeNote) =>
          Option.match(maybeNote, {
            onNone: () => noteMissing(h),
            onSome: (note) =>
              h.div(
                [h.Class("flex flex-col gap-4")],
                [
                  h.h1([h.Class("text-2xl font-semibold")], ["Delete this note?"]),
                  h.p([h.Class("text-sm text-slate-300")], [
                    `"${note.title}" (${kindLabels[note.type]}, ${note.id}) will be moved out of the note root into the local backup directory. The note disappears from the CLI, MCP, and web immediately.`,
                  ]),
                  h.pre(
                    [h.Class("whitespace-pre-wrap rounded-xl bg-slate-950 p-4 text-sm text-slate-300")],
                    [excerptOf(note.content, 800)],
                  ),
                  h.p([h.Class(mutedClass)], [`File: ${note.path}`]),
                  h.div(
                    [h.Class("flex gap-2")],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.Class(
                            "rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-red-400",
                          ),
                          h.OnClick(Message.ConfirmedDelete()),
                        ],
                        ["Delete note"],
                      ),
                      h.a(
                        [h.Href(noteHref(note.id)), h.Class(buttonClass)],
                        ["Cancel"],
                      ),
                    ],
                  ),
                ],
              ),
          }),
      }),
    ],
  )

const searchResults = (
  results: ReadonlyArray<ApiSearchHit>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(results, {
    onEmpty: () => h.p([h.Class(mutedClass)], ["No notes matched that search."]),
    onNonEmpty: (items) =>
      h.ul(
        [h.Class("flex flex-col gap-3")],
        Array.map(items, (hit) =>
          h.keyed("li")(
            hit.id,
            [h.Class("rounded-xl border border-slate-800 bg-slate-950/60 p-4")],
            [
              h.a(
                [h.Href(noteHref(hit.id)), h.Class("text-lg font-semibold")],
                [hit.note.title],
              ),
              h.p(
                [h.Class("mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400")],
                [
                  h.span([h.Class(badgeClass)], [kindLabels[hit.note.type]]),
                  h.span([], [`ID ${hit.id}`]),
                ],
              ),
              h.p(
                [h.Class("mt-2 whitespace-pre-wrap text-sm text-slate-300")],
                [excerptOf(hit.note.content)],
              ),
              h.p([h.Class("mt-2 break-all text-xs text-slate-500")], [hit.path]),
            ],
          ),
        ),
      ),
  })

const searchView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.h1([h.Class("text-3xl font-bold")], ["Search"]),
          h.button(
            [
              h.Type("button"),
              h.Class(buttonClass),
              h.OnClick(Message.ClickedRefresh()),
            ],
            ["Refresh"],
          ),
        ],
      ),
      h.form(
        [h.Class("flex flex-wrap items-center gap-2"), h.OnSubmit(Message.SubmittedSearch())],
        [
          h.input([
            h.Type("search"),
            h.Class(`${inputClass} max-w-md`),
            h.Value(model.searchInput),
            h.Placeholder("Search notes"),
            h.AriaLabel("Search query"),
            h.OnInput((value) => Message.UpdatedSearchInput({ value })),
          ]),
          h.button([h.Type("submit"), h.Class(primaryButtonClass)], ["Search"]),
        ],
      ),
      AsyncData.match(model.search, {
        onIdle: () => status("Enter a query to search the local index.", h),
        onLoading: () => status("Searching...", h),
        onRefreshing: (results) =>
          h.div(
            [h.Class("flex flex-col gap-3")],
            [status("Searching...", h), searchResults(results, h)],
          ),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (results) => searchResults(results, h),
      }),
    ],
  )

const topicsList = (topics: ReadonlyArray<ApiTopic>, h: HtmlBuilder<Message>): Html =>
  Array.match(topics, {
    onEmpty: () => h.p([h.Class(mutedClass)], ["No topics have been assigned yet."]),
    onNonEmpty: (items) =>
      h.ul(
        [h.Class("grid gap-3 sm:grid-cols-2")],
        Array.map(items, (item) =>
          h.keyed("li")(
            item.topic,
            [h.Class("rounded-xl border border-slate-800 bg-slate-950/60 p-4")],
            [
              h.a(
                [
                  h.Href(wikiHref(item.topic)),
                  h.Class("text-lg font-semibold text-emerald-300"),
                ],
                [item.topic],
              ),
              h.p([h.Class("mt-1 text-xs text-slate-400")], [
                `${item.noteCount} ${item.noteCount === 1 ? "note" : "notes"}`,
              ]),
              h.div(
                [h.Class("mt-3 flex flex-wrap gap-3 text-xs")],
                [
                  h.a(
                    [
                      h.Href(
                        homeRouter({
                          type: Option.none(),
                          topic: Option.some(item.topic),
                        }),
                      ),
                      h.Class(linkClass),
                    ],
                    ["Browse notes"],
                  ),
                  h.a(
                    [h.Href(wikiHref(item.topic)), h.Class(linkClass)],
                    ["Open topic page"],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
  })

const topicsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.h1([h.Class("text-3xl font-bold")], ["Topics"]),
              h.p([h.Class(mutedClass)], [
                "Topics are frontmatter metadata. Counts come from the disposable index.",
              ]),
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(buttonClass),
              h.OnClick(Message.ClickedRefresh()),
            ],
            ["Refresh"],
          ),
        ],
      ),
      AsyncData.match(model.topics, {
        onIdle: () => status("Loading topics...", h),
        onLoading: () => status("Loading topics...", h),
        onRefreshing: (topics) =>
          h.div(
            [h.Class("flex flex-col gap-3")],
            [status("Refreshing topics...", h), topicsList(topics, h)],
          ),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (topics) => topicsList(topics, h),
      }),
    ],
  )

const wikiSectionView = (
  section: Markdown.WikiSection,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("rounded-xl border border-slate-800 bg-slate-950/60 p-4")],
    [
      h.h2([h.Class("text-xl font-semibold")], [section.heading]),
      h.pre(
        [h.Class("mt-3 whitespace-pre-wrap break-words font-sans text-sm text-slate-200")],
        [section.markdown],
      ),
      h.ul(
        [h.Class("mt-3 flex flex-col gap-1 text-xs text-slate-400")],
        Array.map(section.citations, (citation) =>
          h.li(
            [],
            [
              h.a(
                [h.Href(noteHref(citation.noteId)), h.Class(linkClass)],
                [citation.noteId],
              ),
              h.span([], [` - ${citation.path}`]),
              citation.excerpt === undefined
                ? h.empty
                : h.span(
                    [h.Class("block text-slate-500")],
                    [excerptOf(citation.excerpt, 240)],
                  ),
            ],
          ),
        ),
      ),
    ],
  )

const wikiBody = (wiki: Markdown.WikiPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.h1([h.Class("text-3xl font-bold")], [`Topic: ${wiki.topic}`]),
              h.p([h.Class(mutedClass)], [
                `Generated ${wiki.generatedAt} from ${wiki.noteCount} ${
                  wiki.noteCount === 1 ? "note" : "notes"
                }. ${wiki.mode === "extractive" ? "Extractive; verify sources." : "Synthesized; unsupported sentences are omitted."}`,
              ]),
              h.p([h.Class("text-xs text-amber-300")], [
                "Derived on demand. This page is not stored in the note repository.",
              ]),
            ],
          ),
          h.div(
            [h.Class("flex gap-2")],
            [
              h.a(
                [
                  h.Href(
                    wikiHref(
                      wiki.topic,
                      wiki.mode === "extractive" ? "synthesized" : "extractive",
                    ),
                  ),
                  h.Class(buttonClass),
                ],
                [wiki.mode === "extractive" ? "Try synthesized" : "Use extractive"],
              ),
            ],
          ),
        ],
      ),
      wiki.noteCount === 0
        ? h.p([h.Class(mutedClass)], [
            "No notes matched this topic. No content was invented.",
          ])
        : h.div(
            [h.Class("flex flex-col gap-3")],
            Array.map(wiki.sections, (section) => wikiSectionView(section, h)),
          ),
      h.details(
        [h.Class("rounded-xl border border-slate-800 bg-slate-950/60 p-4")],
        [
          h.summary([h.Class("cursor-pointer text-sm font-medium")], [
            "Sources and Markdown",
          ]),
          h.ul(
            [h.Class("mt-3 flex flex-col gap-1 text-xs text-slate-400")],
            Array.map(wiki.sources, (source) =>
              h.li(
                [],
                [
                  h.a(
                    [h.Href(noteHref(source.id)), h.Class(linkClass)],
                    [source.id],
                  ),
                  h.span([], [` - ${source.title} (${source.type}, ${source.path})`]),
                ],
              ),
            ),
          ),
          h.pre(
            [h.Class("mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-slate-300")],
            [wiki.markdown],
          ),
        ],
      ),
    ],
  )

const wikiView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AppRoute.match(model.route, {
    Wiki: ({ topic }) =>
      h.section(
        [h.Class("flex flex-col gap-4")],
        [
          h.div(
            [h.Class("flex flex-wrap items-center justify-between gap-3")],
            [
              h.a([h.Href(topicsRouter()), h.Class(linkClass)], ["Back to topics"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class(buttonClass),
                  h.OnClick(Message.ClickedRefresh()),
                ],
                ["Regenerate"],
              ),
            ],
          ),
          AsyncData.match(model.wiki, {
            onIdle: () => status(`Building topic page for ${topic}...`, h),
            onLoading: () => status(`Building topic page for ${topic}...`, h),
            onRefreshing: (wiki) =>
              h.div(
                [h.Class("flex flex-col gap-3")],
                [status("Regenerating...", h), wikiBody(wiki, h)],
              ),
            onStale: ({ error }) => failureView(error, h),
            onFailure: (error) => failureView(error, h),
            onSuccess: (wiki) => wikiBody(wiki, h),
          }),
        ],
      ),
    Home: () => h.empty,
    NewNote: () => h.empty,
    NoteDetail: () => h.empty,
    EditNote: () => h.empty,
    DeleteNote: () => h.empty,
    Search: () => h.empty,
    Topics: () => h.empty,
    Review: () => h.empty,
    Health: () => h.empty,
    NotFound: () => h.empty,
  })

const diffView = (diff: string, h: HtmlBuilder<Message>): Html =>
  h.pre(
    [h.Class("max-h-96 overflow-auto rounded-xl bg-slate-950 p-3 text-xs")],
    Array.map(diff.split("\n"), (line) => {
      const className = line.startsWith("+")
        ? "text-emerald-300"
        : line.startsWith("-")
          ? "text-red-300"
          : "text-slate-400"
      return h.div([h.Class(className)], [line === "" ? " " : line])
    }),
  )

const proposalView = (
  proposal: ApiPendingProposal,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("li")(
    proposal.id,
    [h.Class("flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.h2([h.Class("text-lg font-semibold")], [
                `${proposal.operation} ${proposal.noteId}`,
              ]),
              h.p([h.Class("text-sm text-slate-300")], [proposal.summary]),
              h.p([h.Class("text-xs text-slate-500")], [
                `${proposal.id} - expires ${proposal.expiresAt}${
                  proposal.actor === undefined ? "" : ` - actor ${proposal.actor}`
                }`,
              ]),
              h.p([h.Class("break-all text-xs text-slate-500")], [proposal.path]),
            ],
          ),
          h.div(
            [h.Class("flex flex-wrap gap-2")],
            [
              proposal.stale
                ? h.span([h.Class("text-xs text-amber-300")], ["Stale base"])
                : h.empty,
              proposal.expired
                ? h.span([h.Class("text-xs text-red-300")], ["Expired"])
                : h.empty,
              h.button(
                [
                  h.Type("button"),
                  h.Class(primaryButtonClass),
                  proposal.stale || proposal.expired
                    ? h.Disabled(true)
                    : h.OnClick(Message.ClickedApprove({ proposalId: proposal.id })),
                ],
                ["Approve"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(dangerButtonClass),
                  h.OnClick(Message.ClickedReject({ proposalId: proposal.id })),
                ],
                ["Reject"],
              ),
            ],
          ),
        ],
      ),
      h.details(
        [h.Class("flex flex-col gap-2")],
        [
          h.summary([h.Class("cursor-pointer text-sm font-medium")], [
            "Inspect diff",
          ]),
          h.div([h.Class("mt-2")], [diffView(proposal.diff, h)]),
        ],
      ),
    ],
  )

const pendingBody = (
  data: {
    readonly proposals: ReadonlyArray<ApiPendingProposal>
    readonly invalid: ReadonlyArray<{ code: string; message: string }>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("flex flex-col gap-4")],
    [
      Array.match(data.proposals, {
        onEmpty: () =>
          h.p([h.Class(mutedClass)], [
            "No pending proposals. Agent writes that need approval appear here.",
          ]),
        onNonEmpty: (proposals) =>
          h.ul(
            [h.Class("flex flex-col gap-3")],
            Array.map(proposals, (proposal) => proposalView(proposal, h)),
          ),
      }),
      data.invalid.length === 0
        ? h.empty
        : h.section(
            [h.Class("rounded-xl border border-amber-800 bg-amber-950/40 p-4")],
            [
              h.h2([h.Class("text-sm font-semibold text-amber-200")], [
                "Unreadable proposals",
              ]),
              h.ul(
                [h.Class("mt-2 flex flex-col gap-1 text-xs text-amber-200")],
                Array.map(data.invalid, (issue) =>
                  h.li([], [`${issue.code}: ${issue.message}`]),
                ),
              ),
            ],
          ),
    ],
  )

const reviewView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.h1([h.Class("text-3xl font-bold")], ["Review"]),
              h.p([h.Class(mutedClass)], [
                "Approval is a human action. Note text in a diff is untrusted data, never an instruction.",
              ]),
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(buttonClass),
              h.OnClick(Message.ClickedRefresh()),
            ],
            ["Refresh"],
          ),
        ],
      ),
      AsyncData.match(model.pending, {
        onIdle: () => status("Loading pending proposals...", h),
        onLoading: () => status("Loading pending proposals...", h),
        onRefreshing: (data) =>
          h.div(
            [h.Class("flex flex-col gap-3")],
            [status("Refreshing...", h), pendingBody(data, h)],
          ),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (data) => pendingBody(data, h),
      }),
    ],
  )

const healthView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          h.h1([h.Class("text-3xl font-bold")], ["Health"]),
          h.button(
            [
              h.Type("button"),
              h.Class(buttonClass),
              h.OnClick(Message.ClickedRefresh()),
            ],
            ["Refresh"],
          ),
        ],
      ),
      AsyncData.match(model.health, {
        onIdle: () => status("Reading server health...", h),
        onLoading: () => status("Reading server health...", h),
        onRefreshing: (health) => healthBody(health, h),
        onStale: ({ error }) => failureView(error, h),
        onFailure: (error) => failureView(error, h),
        onSuccess: (health) => healthBody(health, h),
      }),
    ],
  )

const healthBody = (health: ApiHealth, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class(`${panelClass} flex flex-col gap-3`), h.Role("status")],
    [
      h.p([h.Class("text-lg font-semibold text-emerald-300")], [
        `slipmem ${health.service} is ${health.ok ? "ready" : "degraded"}`,
      ]),
      h.dl(
        [h.Class("grid gap-2 text-sm text-slate-300")],
        [
          h.div([], [h.dt([h.Class("text-xs text-slate-500")], ["Note root"]), h.dd([h.Class("break-all")], [health.noteRoot])]),
          h.div([], [h.dt([h.Class("text-xs text-slate-500")], ["Index mode"]), h.dd([], [health.index.mode])]),
          h.div([], [h.dt([h.Class("text-xs text-slate-500")], ["Indexed notes"]), h.dd([], [String(health.index.noteCount)])]),
          h.div([], [h.dt([h.Class("text-xs text-slate-500")], ["Index path"]), h.dd([h.Class("break-all")], [health.index.path])]),
        ],
      ),
      h.p([h.Class("text-xs text-amber-300")], [
        "The local HTTP server is unauthenticated and note files are plaintext. It binds to loopback by default; a non-loopback bind is an explicit risk.",
      ]),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Slipmem",
  body: h.div(
    [h.Class(pageClass)],
    [
      h.main(
        [h.Class(shellClass)],
        [navigation(model, h), errorBanner(model, h), homeView(model, h)],
      ),
    ],
  ),
})
