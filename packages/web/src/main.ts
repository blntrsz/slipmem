import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Note } from "@slipmem/schemas/note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Array, Effect, Match, Option, Order, Result, Schema } from "effect"
import { AsyncData, Command, Http, Runtime, type Update } from "foldkit"
import { type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"

import {
  apiErrorMessage,
  createNote,
  deleteNote,
  listNotes,
  updateNote,
  NoteDraft,
} from "./api"

// MODEL

// Notes use Foldkit's AsyncData so a refresh keeps the last good list visible
// (`Refreshing`), and a failed refresh keeps it with an error (`Stale`).
export const Notes = AsyncData.Schema(Schema.Array(Note.Info), Schema.String)

export const EditorState = defineTaggedUnion({
  Closed: {},
  Open: {
    kind: Note.Kind,
    maybeId: Schema.Option(Schema.String),
    draft: NoteDraft,
  },
  Saving: {
    requestId: Schema.Int,
    kind: Note.Kind,
    maybeId: Schema.Option(Schema.String),
    draft: NoteDraft,
  },
})
type EditorState = typeof EditorState.Type
type SavingEditor = Extract<EditorState, { _tag: "Saving" }>

export const Model = Schema.Struct({
  notes: Notes.schema,
  selectedKind: Note.Kind,
  editor: EditorState,
  lastError: Schema.Option(Schema.String),
  // The newest load request. Results from older requests are ignored.
  loadRequestId: Schema.Int,
  // The newest save request. A save result only closes the editor when it
  // belongs to the request still being saved.
  saveRequestId: Schema.Int,
  // Composite keys of notes deleted during this session. A save response that
  // was already in flight when the note was deleted must not put it back.
  deletedNoteKeys: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedKind: { kind: Note.Kind },
  ClickedNewNote: {},
  ClickedEditNote: { kind: Note.Kind, id: Schema.String },
  ClickedDeleteNote: { kind: Note.Kind, id: Schema.String },
  ClickedCancelEditor: {},
  ClickedSavedNote: {},
  ClickedRefreshNotes: {},
  UpdatedTitle: { title: Schema.String },
  UpdatedContent: { content: Schema.String },
  UpdatedReference: { reference: Schema.String },
  SucceededLoadNotes: { requestId: Schema.Int, notes: Schema.Array(Note.Info) },
  FailedLoadNotes: { requestId: Schema.Int, message: Schema.String },
  SucceededSaveNote: { requestId: Schema.Int, note: Note.Info },
  FailedSaveNote: { requestId: Schema.Int, message: Schema.String },
  SucceededDeleteNote: { kind: Note.Kind, id: Schema.String },
  FailedDeleteNote: { message: Schema.String },
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    notes: AsyncData.Idle(),
    selectedKind: "fleeting",
    editor: EditorState.Closed(),
    lastError: Option.none(),
    loadRequestId: 0,
    saveRequestId: 0,
    deletedNoteKeys: [],
  },
  commands: [LoadNotes({ requestId: 0 })],
})

// COMMAND

const failureMessage = (error: unknown, fallback: string): string =>
  apiErrorMessage(error, fallback)

export const LoadNotes = Command.define("LoadNotes", {
  args: { requestId: Schema.Int },
  messages: [Message.SucceededLoadNotes, Message.FailedLoadNotes],
  execute: ({ requestId }) =>
    listNotes.pipe(
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

export const CreateNote = Command.define("CreateNote", {
  args: { requestId: Schema.Int, kind: Note.Kind, draft: NoteDraft },
  messages: [Message.SucceededSaveNote, Message.FailedSaveNote],
  execute: ({ requestId, kind, draft }) =>
    createNote(kind, draft).pipe(
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
    ),
})

export const UpdateNote = Command.define("UpdateNote", {
  args: {
    requestId: Schema.Int,
    kind: Note.Kind,
    id: Schema.String,
    draft: NoteDraft,
  },
  messages: [Message.SucceededSaveNote, Message.FailedSaveNote],
  execute: ({ requestId, kind, id, draft }) =>
    updateNote(kind, id, draft).pipe(
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
    ),
})

export const DeleteNote = Command.define("DeleteNote", {
  args: { kind: Note.Kind, id: Schema.String },
  messages: [Message.SucceededDeleteNote, Message.FailedDeleteNote],
  execute: ({ kind, id }) =>
    deleteNote(kind, id).pipe(
      Effect.map(() => Message.SucceededDeleteNote({ kind, id })),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteNote({
            message: failureMessage(error, "Could not delete the note."),
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const kindLabels: Readonly<Record<Note.Kind, string>> = {
  fleeting: "Fleeting",
  literature: "Literature",
  permanent: "Permanent",
}

// Ids are only unique within a note table, so every lookup and removal includes
// the kind as well as the id.
const noteKey = (note: {
  readonly type: Note.Kind
  readonly id: string
}): string => `${note.type}\u0000${note.id}`

const noteOrder = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (note: Note.Info) => note.updatedAt),
  Order.mapInput(Order.String, noteKey),
)

const sortNotes = (notes: ReadonlyArray<Note.Info>): ReadonlyArray<Note.Info> =>
  Array.sort(notes, noteOrder)

const notesOf = (state: typeof Notes.schema.Type): ReadonlyArray<Note.Info> =>
  AsyncData.getOrElse(state, () => [])

const notesForKind = (
  state: typeof Notes.schema.Type,
  kind: Note.Kind,
): ReadonlyArray<Note.Info> =>
  Array.filter(notesOf(state), (note) => note.type === kind)

const upsertNote = (
  notes: ReadonlyArray<Note.Info>,
  note: Note.Info,
): ReadonlyArray<Note.Info> =>
  sortNotes([
    ...Array.filter(notes, (existing) => noteKey(existing) !== noteKey(note)),
    note,
  ])

const removeNote = (
  notes: ReadonlyArray<Note.Info>,
  kind: Note.Kind,
  id: string,
): ReadonlyArray<Note.Info> =>
  Array.filter(
    notes,
    (note) => note.type !== kind || note.id !== id,
  )

// Apply a mutation result directly to the cached list and settle any pending
// refresh. A mutation invalidates the older load below, so leaving `Refreshing`
// or `Stale` here would make the list pending forever: the invalidated load
// can no longer deliver the message that would finish it.
const settleNotesWith = (
  state: typeof Notes.schema.Type,
  update: (notes: ReadonlyArray<Note.Info>) => ReadonlyArray<Note.Info>,
): typeof Notes.schema.Type =>
  AsyncData.match(state, {
    onIdle: () => state,
    onLoading: () => state,
    onFailure: () => state,
    onRefreshing: (data) => AsyncData.Success({ data: update(data) }),
    onStale: ({ data }) => AsyncData.Success({ data: update(data) }),
    onSuccess: (data) => AsyncData.Success({ data: update(data) }),
  })

const refreshState = (
  state: typeof Notes.schema.Type,
): typeof Notes.schema.Type =>
  Option.match(AsyncData.getData(state), {
    onNone: () => AsyncData.Loading(),
    onSome: (data) => AsyncData.Refreshing({ data }),
  })

const failedLoadState = (
  state: typeof Notes.schema.Type,
  message: string,
): typeof Notes.schema.Type =>
  Option.match(AsyncData.getData(state), {
    onNone: () => AsyncData.Failure({ error: message }),
    onSome: (data) => AsyncData.Stale({ error: message, data }),
  })

const editorFromSaving = (saving: SavingEditor): EditorState =>
  EditorState.Open({
    kind: saving.kind,
    maybeId: saving.maybeId,
    draft: saving.draft,
  })

const referenceOf = (note: Note.Info): string =>
  Note.Info.match(note, {
    fleeting: () => "",
    permanent: () => "",
    literature: ({ reference }) => reference,
  })

const draftSchema = (kind: Note.Kind) =>
  Match.value(kind).pipe(
    Match.when("fleeting", () => FleetingNote.CreateInput),
    Match.when("literature", () => LiteratureNote.CreateInput),
    Match.when("permanent", () => PermanentNote.CreateInput),
    Match.exhaustive,
  )

// Validate against the same per-kind schema the HTTP and MCP inputs use, so
// the form cannot accept a draft the server will reject.
const draftError = (
  kind: Note.Kind,
  draft: NoteDraft,
): Option.Option<string> => {
  const normalized = { ...draft, reference: draft.reference ?? "" }
  const result = Schema.decodeUnknownResult(draftSchema(kind))(normalized)

  return Result.match(result, {
    onSuccess: () => Option.none(),
    // Schema errors include a pointer path after the human-readable first line.
    // The path is useful in logs, but the alert only needs the message.
    onFailure: (error) =>
      Option.some(error.message.split("\n")[0] || error.message),
  })
}

const withDraft = (
  editor: EditorState,
  changes: Partial<NoteDraft>,
): EditorState =>
  EditorState.match(editor, {
    Closed: () => editor,
    Saving: () => editor,
    Open: ({ kind, maybeId, draft }) =>
      EditorState.Open({
        kind,
        maybeId,
        draft: { ...draft, ...changes },
      }),
  })

const startSave = (model: Model, editor: EditorState): UpdateReturn =>
  EditorState.match<UpdateReturn>(editor, {
    Closed: () => ({ model }),
    Saving: () => ({ model }),
    Open: ({ kind, maybeId, draft }) => {
      const maybeError = draftError(kind, draft)
      if (Option.isSome(maybeError)) {
        return { model: modifyFields(model, { lastError: () => maybeError }) }
      }

      const requestId = model.saveRequestId + 1
      const normalized = { ...draft, reference: draft.reference ?? "" }
      const saving = EditorState.Saving({
        requestId,
        kind,
        maybeId,
        draft: normalized,
      })

      const commands = Option.match(maybeId, {
        onNone: () => [CreateNote({ requestId, kind, draft: normalized })],
        onSome: (id) => [
          UpdateNote({ requestId, kind, id, draft: normalized }),
        ],
      })

      return {
        model: modifyFields(model, {
          editor: () => saving,
          lastError: () => Option.none(),
          saveRequestId: () => requestId,
        }),
        commands,
      }
    },
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedKind: ({ kind }) => {
      if (kind === model.selectedKind) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          selectedKind: () => kind,
          editor: () => EditorState.Closed(),
          lastError: () => Option.none(),
        }),
      }
    },

    ClickedNewNote: () => ({
      model: modifyFields(model, {
        editor: () =>
          EditorState.Open({
            kind: model.selectedKind,
            maybeId: Option.none(),
            draft: { title: "", content: "", reference: "" },
          }),
        lastError: () => Option.none(),
      }),
    }),

    ClickedEditNote: ({ kind, id }) => {
      const maybeNote = Array.findFirst(
        notesForKind(model.notes, kind),
        (note) => note.id === id,
      )
      if (Option.isNone(maybeNote)) {
        return { model }
      }

      const note = maybeNote.value
      return {
        model: modifyFields(model, {
          editor: () =>
            EditorState.Open({
              kind,
              maybeId: Option.some(id),
              draft: {
                title: note.title,
                content: note.content,
                reference: referenceOf(note),
              },
            }),
          lastError: () => Option.none(),
        }),
      }
    },

    ClickedDeleteNote: ({ kind, id }) => ({
      model: modifyFields(model, { lastError: () => Option.none() }),
      commands: [DeleteNote({ kind, id })],
    }),

    ClickedCancelEditor: () => ({
      model: modifyFields(model, {
        editor: () => EditorState.Closed(),
        lastError: () => Option.none(),
      }),
    }),

    ClickedSavedNote: () => startSave(model, model.editor),

    ClickedRefreshNotes: () => {
      const requestId = model.loadRequestId + 1

      return {
        model: modifyFields(model, {
          notes: () => refreshState(model.notes),
          lastError: () => Option.none(),
          loadRequestId: () => requestId,
        }),
        commands: [LoadNotes({ requestId })],
      }
    },

    UpdatedTitle: ({ title }) => ({
      model: modifyFields(model, {
        editor: () => withDraft(model.editor, { title }),
      }),
    }),

    UpdatedContent: ({ content }) => ({
      model: modifyFields(model, {
        editor: () => withDraft(model.editor, { content }),
      }),
    }),

    UpdatedReference: ({ reference }) => ({
      model: modifyFields(model, {
        editor: () => withDraft(model.editor, { reference }),
      }),
    }),

    SucceededLoadNotes: ({ requestId, notes }) => {
      if (requestId !== model.loadRequestId) {
        // A newer load has already started; this result is stale.
        return { model }
      }

      const sortedNotes = sortNotes(notes)
      const loadedKeys = new Set(Array.map(sortedNotes, noteKey))
      // A successful load is authoritative: a note that is present again was
      // recreated, so an old save response may update it. Notes that are absent
      // keep their tombstone so a late save cannot resurrect them.
      const remainingDeletedKeys = Array.filter(
        model.deletedNoteKeys,
        (key) => !loadedKeys.has(key),
      )

      return {
        model: modifyFields(model, {
          notes: () => AsyncData.Success({ data: sortedNotes }),
          lastError: () => Option.none(),
          deletedNoteKeys: () => remainingDeletedKeys,
        }),
      }
    },

    FailedLoadNotes: ({ requestId, message }) => {
      if (requestId !== model.loadRequestId) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          notes: () => failedLoadState(model.notes, message),
          // Keep the list's own error state as the single load-failure message.
          lastError: () => Option.none(),
        }),
      }
    },

    SucceededSaveNote: ({ requestId, note }) => {
      const isCurrentSave = EditorState.match(model.editor, {
        Saving: (saving) => saving.requestId === requestId,
        Closed: () => false,
        Open: () => false,
      })
      const key = noteKey(note)

      // The delete may have reached the server first, or its response may
      // simply have arrived first. Either way the note is gone, and this save
      // response was already in flight when that happened.
      if (Array.contains(model.deletedNoteKeys, key)) {
        return isCurrentSave
          ? {
              model: modifyFields(model, {
                editor: () => EditorState.Closed(),
                lastError: () => Option.none(),
              }),
            }
          : { model }
      }

      const hasData = AsyncData.hasData(model.notes)
      const nextNotes = hasData
        ? settleNotesWith(model.notes, (notes) => upsertNote(notes, note))
        : AsyncData.Success({ data: [note] })
      const nextLoadRequestId = model.loadRequestId + 1

      // Saving changes the server data. Invalidate any list load that was
      // already in flight so it cannot overwrite this result with older data.
      if (!isCurrentSave) {
        return {
          model: modifyFields(model, {
            notes: () => nextNotes,
            loadRequestId: () => nextLoadRequestId,
          }),
          commands: hasData
            ? undefined
            : [LoadNotes({ requestId: nextLoadRequestId })],
        }
      }

      return {
        model: modifyFields(model, {
          notes: () => nextNotes,
          selectedKind: () => note.type,
          editor: () => EditorState.Closed(),
          lastError: () => Option.none(),
          loadRequestId: () => nextLoadRequestId,
        }),
        commands: hasData
          ? undefined
          : [LoadNotes({ requestId: nextLoadRequestId })],
      }
    },

    FailedSaveNote: ({ requestId, message }) => {
      const isCurrentSave = EditorState.match(model.editor, {
        Saving: (saving) => saving.requestId === requestId,
        Closed: () => false,
        Open: () => false,
      })
      if (!isCurrentSave) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          editor: () =>
            EditorState.match(model.editor, {
              Closed: () => model.editor,
              Open: () => model.editor,
              Saving: (saving) => editorFromSaving(saving),
            }),
          lastError: () => Option.some(message),
        }),
      }
    },

    SucceededDeleteNote: ({ kind, id }) => {
      const deletedKey = noteKey({ type: kind, id })
      const nextDeletedKeys = Array.contains(model.deletedNoteKeys, deletedKey)
        ? model.deletedNoteKeys
        : [...model.deletedNoteKeys, deletedKey]
      const hasData = AsyncData.hasData(model.notes)
      const nextNotes = hasData
        ? settleNotesWith(model.notes, (notes) => removeNote(notes, kind, id))
        : refreshState(model.notes)
      const nextLoadRequestId = model.loadRequestId + 1
      const editorMatchesDeletedNote = EditorState.match(model.editor, {
        Open: ({ kind: editorKind, maybeId }) =>
          editorKind === kind &&
          Option.exists(maybeId, (editorId) => editorId === id),
        Saving: ({ kind: editorKind, maybeId }) =>
          editorKind === kind &&
          Option.exists(maybeId, (editorId) => editorId === id),
        Closed: () => false,
      })

      return {
        model: modifyFields(model, {
          notes: () => nextNotes,
          editor: () =>
            editorMatchesDeletedNote ? EditorState.Closed() : model.editor,
          lastError: () => Option.none(),
          loadRequestId: () => nextLoadRequestId,
          deletedNoteKeys: () => nextDeletedKeys,
        }),
        commands: hasData
          ? undefined
          : [LoadNotes({ requestId: nextLoadRequestId })],
      }
    },

    FailedDeleteNote: ({ message }) => ({
      model: modifyFields(model, {
        lastError: () => Option.some(message),
      }),
    }),
  })

// VIEW

const pageClass = "min-h-screen bg-slate-950 text-slate-100"
const shellClass = "mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10"
const panelClass = "rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl"
const buttonClass =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
const primaryButtonClass =
  "rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
const dangerButtonClass =
  "rounded-lg border border-red-900 bg-red-950 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-900"
const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-400"

const titleFieldId = "note-title"
const contentFieldId = "note-content"
const referenceFieldId = "note-reference"
const notesHeadingId = "notes-heading"

const statusMessage = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class("text-sm text-slate-400"), h.Role("status"), h.AriaLive("polite")],
    [text],
  )

const kindTab = (
  model: Model,
  kind: Note.Kind,
  h: HtmlBuilder<Message>,
): Html => {
  const isSelected = model.selectedKind === kind
  const count = Array.length(notesForKind(model.notes, kind))
  const tabClass = isSelected
    ? "rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950"
    : "rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700"

  return h.button(
    [
      h.Type("button"),
      h.Class(tabClass),
      h.AriaPressed(isSelected ? "true" : "false"),
      h.OnClick(Message.ClickedKind({ kind })),
    ],
    [`${kindLabels[kind]} ${count === 0 ? "" : `(${count})`}`.trim()],
  )
}

const noteCard = (note: Note.Info, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    noteKey(note),
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
              h.h3([h.Class("text-lg font-semibold text-slate-100")], [note.title]),
              h.p(
                [h.Class("text-xs uppercase tracking-wide text-emerald-400")],
                [kindLabels[note.type]],
              ),
            ],
          ),
          h.div(
            [h.Class("flex gap-2")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class(buttonClass),
                  h.AriaLabel(`Edit ${kindLabels[note.type].toLowerCase()} note: ${note.title}`),
                  h.OnClick(Message.ClickedEditNote({ kind: note.type, id: note.id })),
                ],
                ["Edit"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(dangerButtonClass),
                  h.AriaLabel(`Delete ${kindLabels[note.type].toLowerCase()} note: ${note.title}`),
                  h.OnClick(Message.ClickedDeleteNote({ kind: note.type, id: note.id })),
                ],
                ["Delete"],
              ),
            ],
          ),
        ],
      ),
      h.p([h.Class("whitespace-pre-wrap text-sm text-slate-300")], [note.content]),
      Note.Info.match(note, {
        fleeting: () => h.empty,
        permanent: () => h.empty,
        literature: ({ reference }) =>
          h.p(
            [h.Class("rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-400")],
            [`Source: ${reference}`],
          ),
      }),
    ],
  )

const notesForData = (
  model: Model,
  notes: ReadonlyArray<Note.Info>,
  h: HtmlBuilder<Message>,
): Html => {
  const visibleNotes = Array.filter(
    notes,
    (note) => note.type === model.selectedKind,
  )

  return Array.match(visibleNotes, {
    onEmpty: () =>
      h.p(
        [h.Class("text-sm text-slate-400")],
        [
          `No ${kindLabels[model.selectedKind].toLowerCase()} notes yet. Create one to get started.`,
        ],
      ),
    onNonEmpty: (items) =>
      h.ul(
        [h.Class("flex flex-col gap-3")],
        Array.map(items, (note) => noteCard(note, h)),
      ),
  })
}

const retryButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(buttonClass),
      h.OnClick(Message.ClickedRefreshNotes()),
    ],
    ["Retry"],
  )

const notesList = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.notes, {
    onIdle: () => statusMessage("Loading notes...", h),
    onLoading: () => statusMessage("Loading notes...", h),
    onRefreshing: (notes) =>
      h.div(
        [h.Class("flex flex-col gap-3")],
        [statusMessage("Refreshing notes...", h), notesForData(model, notes, h)],
      ),
    onStale: ({ data }) =>
      h.div(
        [h.Class("flex flex-col gap-3")],
        [
          h.div(
            [h.Class("flex flex-col items-start gap-3")],
            [
              h.p(
                [h.Class("text-sm text-amber-300")],
                ["Could not refresh notes. Showing the last loaded notes."],
              ),
              retryButton(h),
            ],
          ),
          notesForData(model, data, h),
        ],
      ),
    onFailure: (message) =>
      h.div(
        [h.Class("flex flex-col items-start gap-3")],
        [
          h.p([h.Class("text-sm text-red-300")], [message]),
          retryButton(h),
        ],
      ),
    onSuccess: (notes) => notesForData(model, notes, h),
  })

const fieldLabel = (
  text: string,
  fieldId: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [h.For(fieldId), h.Class("text-sm font-medium text-slate-300")],
    [text],
  )

const field = (
  label: string,
  fieldId: string,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("flex flex-col gap-1")],
    [fieldLabel(label, fieldId, h), control],
  )

const editorFields = (
  kind: Note.Kind,
  draft: NoteDraft,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const reference = draft.reference ?? ""
  const isLiterature = kind === "literature"

  return [
    field(
      "Title",
      titleFieldId,
      h.input([
        h.Id(titleFieldId),
        h.Class(inputClass),
        h.Value(draft.title),
        h.Placeholder("A short title"),
        h.Autocomplete("off"),
        h.Required(true),
        h.OnInput((value) => Message.UpdatedTitle({ title: value })),
      ]),
      h,
    ),
    field(
      "Content",
      contentFieldId,
      h.textarea([
        h.Id(contentFieldId),
        h.Class(inputClass),
        h.Value(draft.content),
        h.Placeholder("Write the note"),
        h.Rows(5),
        h.Required(true),
        h.OnInput((value) => Message.UpdatedContent({ content: value })),
      ]),
      h,
    ),
    isLiterature
      ? field(
          "Reference",
          referenceFieldId,
          h.input([
            h.Id(referenceFieldId),
            h.Class(inputClass),
            h.Value(reference),
            h.Placeholder("Book, article, or URL"),
            h.Autocomplete("off"),
            h.Required(true),
            h.OnInput((value) =>
              Message.UpdatedReference({ reference: value }),
            ),
          ]),
          h,
        )
      : h.empty,
  ]
}

const formHeader = (
  heading: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("mb-4 flex items-center justify-between gap-3")],
    [
      h.h2([h.Class("text-xl font-semibold")], [heading]),
      h.button(
        [
          h.Type("button"),
          h.Class(buttonClass),
          h.OnClick(Message.ClickedCancelEditor()),
        ],
        ["Cancel"],
      ),
    ],
  )

const editorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  EditorState.match(model.editor, {
    Closed: () => h.empty,
    Saving: ({ kind, draft }) => {
      const reference = draft.reference ?? ""
      const isLiterature = kind === "literature"

      return h.form(
        [h.Class(panelClass), h.OnSubmit(Message.ClickedSavedNote())],
        [
          h.h2(
            [h.Class("text-xl font-semibold"), h.Role("status"), h.AriaLive("polite")],
            [`Saving ${kindLabels[kind].toLowerCase()} note`],
          ),
          h.p([h.Class("text-sm text-slate-400")], [draft.title]),
          h.p(
            [h.Class("whitespace-pre-wrap text-sm text-slate-400")],
            [draft.content],
          ),
          isLiterature
            ? h.p(
                [h.Class("text-sm text-slate-400")],
                [`Source: ${reference}`],
              )
            : h.empty,
        ],
      )
    },
    Open: ({ kind, maybeId, draft }) => {
      const isCreating = Option.isNone(maybeId)
      const heading = isCreating
        ? `New ${kindLabels[kind].toLowerCase()} note`
        : `Edit ${kindLabels[kind].toLowerCase()} note`

      return h.form(
        [h.Class(panelClass), h.OnSubmit(Message.ClickedSavedNote())],
        [
          formHeader(heading, h),
          h.div(
            [h.Class("flex flex-col gap-4")],
            [
              ...editorFields(kind, draft, h),
              h.button(
                [h.Type("submit"), h.Class(primaryButtonClass)],
                [isCreating ? "Save note" : "Save changes"],
              ),
            ],
          ),
        ],
      )
    },
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Slipmem notes",
  body: h.div(
    [h.Class(pageClass)],
    [
      h.main(
        [h.Class(shellClass)],
        [
          h.header(
            [h.Class("flex flex-wrap items-end justify-between gap-4")],
            [
              h.div(
                [h.Class("flex flex-col gap-2")],
                [
                  h.h1([h.Class("text-4xl font-bold tracking-tight")], ["Slipmem"]),
                  h.p(
                    [h.Class("max-w-2xl text-sm text-slate-400")],
                    [
                      "A local-first notebook for fleeting, literature, and permanent notes. Changes are stored in SQLite and exposed over JSON and MCP.",
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("flex gap-2")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Class(buttonClass),
                      h.OnClick(Message.ClickedRefreshNotes()),
                    ],
                    ["Refresh"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class(primaryButtonClass),
                      h.OnClick(Message.ClickedNewNote()),
                    ],
                    ["New note"],
                  ),
                ],
              ),
            ],
          ),

          h.nav(
            [h.Class("flex flex-wrap gap-2"), h.AriaLabel("Filter notes by kind")],
            [
              kindTab(model, "fleeting", h),
              kindTab(model, "literature", h),
              kindTab(model, "permanent", h),
            ],
          ),

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
          }),

          editorView(model, h),

          h.section(
            [
              h.Class(panelClass),
              h.AriaLabelledBy(notesHeadingId),
              h.AriaBusy(AsyncData.isPending(model.notes)),
            ],
            [
              h.div(
                [h.Class("mb-4 flex items-center justify-between gap-3")],
                [
                  h.h2(
                    [h.Id(notesHeadingId), h.Class("text-xl font-semibold")],
                    [`${kindLabels[model.selectedKind]} notes`],
                  ),
                  h.span(
                    [h.Class("text-sm text-slate-400")],
                    [
                      `${Array.length(notesForKind(model.notes, model.selectedKind))} total`,
                    ],
                  ),
                ],
              ),
              notesList(model, h),
            ],
          ),
        ],
      ),
    ],
  ),
})
