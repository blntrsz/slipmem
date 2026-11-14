import { Note } from "@slipmem/schemas/note"
import { Array, Effect, Option, Schema, String } from "effect"
import { Command, Http, Runtime, type Update } from "foldkit"
import { type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"

import {
  createNote,
  deleteNote,
  listNotes,
  updateNote,
  NoteDraft,
} from "./api"

// MODEL

export const NotesState = defineTaggedUnion({
  Idle: {},
  Loading: {},
  Loaded: { notes: Schema.Array(Note.Info) },
  Failed: { message: Schema.String },
})
type NotesState = typeof NotesState.Type

export const EditorState = defineTaggedUnion({
  Closed: {},
  Creating: {
    kind: Note.Kind,
    title: Schema.String,
    content: Schema.String,
    reference: Schema.String,
  },
  Editing: {
    kind: Note.Kind,
    id: Schema.String,
    title: Schema.String,
    content: Schema.String,
    reference: Schema.String,
  },
  Saving: {
    kind: Note.Kind,
    maybeId: Schema.Option(Schema.String),
    title: Schema.String,
    content: Schema.String,
    reference: Schema.String,
  },
})
type EditorState = typeof EditorState.Type
type SavingEditor = Extract<EditorState, { _tag: "Saving" }>

export const Model = Schema.Struct({
  notes: NotesState,
  selectedKind: Note.Kind,
  editor: EditorState,
  lastError: Schema.Option(Schema.String),
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
  SucceededLoadNotes: { notes: Schema.Array(Note.Info) },
  FailedLoadNotes: { message: Schema.String },
  SucceededSaveNote: { note: Note.Info },
  FailedSaveNote: { message: Schema.String },
  SucceededDeleteNote: { id: Schema.String },
  FailedDeleteNote: { message: Schema.String },
})
export type Message = typeof Message.Type

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    notes: NotesState.Idle(),
    selectedKind: "fleeting",
    editor: EditorState.Closed(),
    lastError: Option.none(),
  },
  commands: [LoadNotes()],
})

// COMMAND

export const LoadNotes = Command.define("LoadNotes", {
  messages: [Message.SucceededLoadNotes, Message.FailedLoadNotes],
  execute: listNotes.pipe(
    Effect.map((notes) => Message.SucceededLoadNotes({ notes })),
    Effect.catch(() =>
      Effect.succeed(Message.FailedLoadNotes({ message: "Could not load notes." })),
    ),
    Effect.provide(Http.layer),
  ),
})

export const CreateNote = Command.define("CreateNote", {
  args: { kind: Note.Kind, draft: NoteDraft },
  messages: [Message.SucceededSaveNote, Message.FailedSaveNote],
  execute: ({ kind, draft }) =>
    createNote(kind, draft).pipe(
      Effect.map((note) => Message.SucceededSaveNote({ note })),
      Effect.catch(() =>
        Effect.succeed(Message.FailedSaveNote({ message: "Could not save the note." })),
      ),
      Effect.provide(Http.layer),
    ),
})

export const UpdateNote = Command.define("UpdateNote", {
  args: { kind: Note.Kind, id: Schema.String, draft: NoteDraft },
  messages: [Message.SucceededSaveNote, Message.FailedSaveNote],
  execute: ({ kind, id, draft }) =>
    updateNote(kind, id, draft).pipe(
      Effect.map((note) => Message.SucceededSaveNote({ note })),
      Effect.catch(() =>
        Effect.succeed(Message.FailedSaveNote({ message: "Could not save the note." })),
      ),
      Effect.provide(Http.layer),
    ),
})

export const DeleteNote = Command.define("DeleteNote", {
  args: { kind: Note.Kind, id: Schema.String },
  messages: [Message.SucceededDeleteNote, Message.FailedDeleteNote],
  execute: ({ kind, id }) =>
    deleteNote(kind, id).pipe(
      Effect.map(() => Message.SucceededDeleteNote({ id })),
      Effect.catch(() =>
        Effect.succeed(Message.FailedDeleteNote({ message: "Could not delete the note." })),
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

const notesForKind = (state: NotesState, kind: Note.Kind): ReadonlyArray<Note.Info> =>
  NotesState.match(state, {
    Idle: () => [],
    Loading: () => [],
    Failed: () => [],
    Loaded: ({ notes }) => Array.filter(notes, (note) => note.type === kind),
  })

const withLoadedNote = (state: NotesState, note: Note.Info): NotesState =>
  NotesState.match(state, {
    Idle: () => NotesState.Loaded({ notes: [note] }),
    Loading: () => NotesState.Loaded({ notes: [note] }),
    Failed: () => NotesState.Loaded({ notes: [note] }),
    Loaded: ({ notes }) => {
      const withoutNote = Array.filter(notes, (existing) => existing.id !== note.id)
      return NotesState.Loaded({ notes: [...withoutNote, note] })
    },
  })

const withoutNote = (state: NotesState, id: string): NotesState =>
  NotesState.match(state, {
    Idle: () => state,
    Loading: () => state,
    Failed: () => state,
    Loaded: ({ notes }) =>
      NotesState.Loaded({ notes: Array.filter(notes, (note) => note.id !== id) }),
  })

const editorFromSaving = (saving: SavingEditor): EditorState =>
  Option.match(saving.maybeId, {
    onNone: () =>
      EditorState.Creating({
        kind: saving.kind,
        title: saving.title,
        content: saving.content,
        reference: saving.reference,
      }),
    onSome: (id) =>
      EditorState.Editing({
        kind: saving.kind,
        id,
        title: saving.title,
        content: saving.content,
        reference: saving.reference,
      }),
  })

const referenceOf = (note: Note.Info): string =>
  Note.Info.match(note, {
    fleeting: () => "",
    permanent: () => "",
    literature: ({ reference }) => reference,
  })

const draftError = (kind: Note.Kind, draft: NoteDraft): Option.Option<string> => {
  if (String.isEmpty(String.trim(draft.title))) {
    return Option.some("Title is required.")
  }
  if (String.isEmpty(String.trim(draft.content))) {
    return Option.some("Content is required.")
  }
  if (kind === "literature" && String.isEmpty(String.trim(draft.reference))) {
    return Option.some("Reference is required for literature notes.")
  }
  return Option.none()
}

const startSave = (model: Model, editor: EditorState): UpdateReturn =>
  EditorState.match<UpdateReturn>(editor, {
    Closed: () => ({ model }),
    Saving: () => ({ model }),
    Creating: ({ kind, title, content, reference }) => {
      const draft = { title, content, reference }
      const maybeError = draftError(kind, draft)
      if (Option.isSome(maybeError)) {
        return { model: modifyFields(model, { lastError: () => maybeError }) }
      }

      return {
        model: modifyFields(model, {
          editor: () =>
            EditorState.Saving({
              kind,
              maybeId: Option.none(),
              title,
              content,
              reference,
            }),
          lastError: () => Option.none(),
        }),
        commands: [CreateNote({ kind, draft })],
      }
    },
    Editing: ({ kind, id, title, content, reference }) => {
      const draft = { title, content, reference }
      const maybeError = draftError(kind, draft)
      if (Option.isSome(maybeError)) {
        return { model: modifyFields(model, { lastError: () => maybeError }) }
      }

      return {
        model: modifyFields(model, {
          editor: () =>
            EditorState.Saving({
              kind,
              maybeId: Option.some(id),
              title,
              content,
              reference,
            }),
          lastError: () => Option.none(),
        }),
        commands: [UpdateNote({ kind, id, draft })],
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
          EditorState.Creating({
            kind: model.selectedKind,
            title: "",
            content: "",
            reference: "",
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
            EditorState.Editing({
              kind,
              id,
              title: note.title,
              content: note.content,
              reference: referenceOf(note),
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

    ClickedRefreshNotes: () => ({
      model: modifyFields(model, {
        notes: () => NotesState.Loading(),
        lastError: () => Option.none(),
      }),
      commands: [LoadNotes()],
    }),

    UpdatedTitle: ({ title }) => ({
      model: modifyFields(model, {
        editor: () =>
          EditorState.match(model.editor, {
            Closed: () => model.editor,
            Saving: () => model.editor,
            Creating: (editor) => EditorState.Creating({ ...editor, title }),
            Editing: (editor) => EditorState.Editing({ ...editor, title }),
          }),
      }),
    }),

    UpdatedContent: ({ content }) => ({
      model: modifyFields(model, {
        editor: () =>
          EditorState.match(model.editor, {
            Closed: () => model.editor,
            Saving: () => model.editor,
            Creating: (editor) => EditorState.Creating({ ...editor, content }),
            Editing: (editor) => EditorState.Editing({ ...editor, content }),
          }),
      }),
    }),

    UpdatedReference: ({ reference }) => ({
      model: modifyFields(model, {
        editor: () =>
          EditorState.match(model.editor, {
            Closed: () => model.editor,
            Saving: () => model.editor,
            Creating: (editor) => EditorState.Creating({ ...editor, reference }),
            Editing: (editor) => EditorState.Editing({ ...editor, reference }),
          }),
      }),
    }),

    SucceededLoadNotes: ({ notes }) => ({
      model: modifyFields(model, {
        notes: () => NotesState.Loaded({ notes }),
        lastError: () => Option.none(),
      }),
    }),

    FailedLoadNotes: ({ message }) => ({
      model: modifyFields(model, {
        notes: () => NotesState.Failed({ message }),
        lastError: () => Option.some(message),
      }),
    }),

    SucceededSaveNote: ({ note }) => ({
      model: modifyFields(model, {
        notes: () => withLoadedNote(model.notes, note),
        selectedKind: () => note.type,
        editor: () => EditorState.Closed(),
        lastError: () => Option.none(),
      }),
    }),

    FailedSaveNote: ({ message }) => ({
      model: modifyFields(model, {
        editor: () =>
          EditorState.match(model.editor, {
            Closed: () => model.editor,
            Creating: () => model.editor,
            Editing: () => model.editor,
            Saving: (saving) => editorFromSaving(saving),
          }),
        lastError: () => Option.some(message),
      }),
    }),

    SucceededDeleteNote: ({ id }) => ({
      model: modifyFields(model, {
        notes: () => withoutNote(model.notes, id),
        lastError: () => Option.none(),
      }),
    }),

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
      h.OnClick(Message.ClickedKind({ kind })),
    ],
    [`${kindLabels[kind]} ${count === 0 ? "" : `(${count})`}`.trim()],
  )
}

const noteCard = (note: Note.Info, h: HtmlBuilder<Message>): Html =>
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
                  h.OnClick(Message.ClickedEditNote({ kind: note.type, id: note.id })),
                ],
                ["Edit"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(dangerButtonClass),
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

const notesList = (model: Model, h: HtmlBuilder<Message>): Html =>
  NotesState.match(model.notes, {
    Idle: () =>
      h.p([h.Class("text-sm text-slate-400")], ["Loading notes..."]),
    Loading: () =>
      h.p([h.Class("text-sm text-slate-400")], ["Loading notes..."]),
    Failed: ({ message }) =>
      h.div(
        [h.Class("flex flex-col items-start gap-3")],
        [
          h.p([h.Class("text-sm text-red-300")], [message]),
          h.button(
            [
              h.Type("button"),
              h.Class(buttonClass),
              h.OnClick(Message.ClickedRefreshNotes()),
            ],
            ["Retry"],
          ),
        ],
      ),
    Loaded: () => {
      const notes = notesForKind(model.notes, model.selectedKind)
      return Array.match(notes, {
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
    },
  })

const fieldLabel = (text: string, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class("text-sm font-medium text-slate-300")], [text])

const editorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  EditorState.match(model.editor, {
    Closed: () => h.empty,
    Saving: ({ kind, title, content, reference }) => {
      const isLiterature = kind === "literature"
      return h.form(
        [
          h.Class(panelClass),
          h.OnSubmit(Message.ClickedSavedNote()),
        ],
        [
          h.h2([h.Class("text-xl font-semibold")], [`Saving ${kindLabels[kind].toLowerCase()} note`]),
          h.p([h.Class("text-sm text-slate-400")], [title]),
          h.p([h.Class("whitespace-pre-wrap text-sm text-slate-400")], [content]),
          isLiterature
            ? h.p([h.Class("text-sm text-slate-400")], [`Source: ${reference}`])
            : h.empty,
        ],
      )
    },
    Creating: ({ kind, title, content, reference }) => {
      const isLiterature = kind === "literature"
      return h.form(
        [
          h.Class(panelClass),
          h.OnSubmit(Message.ClickedSavedNote()),
        ],
        [
          h.div(
            [h.Class("mb-4 flex items-center justify-between gap-3")],
            [
              h.h2(
                [h.Class("text-xl font-semibold")],
                [`New ${kindLabels[kind].toLowerCase()} note`],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(buttonClass),
                  h.OnClick(Message.ClickedCancelEditor()),
                ],
                ["Cancel"],
              ),
            ],
          ),
          h.div(
            [h.Class("flex flex-col gap-4")],
            [
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  fieldLabel("Title", h),
                  h.input([
                    h.Class(inputClass),
                    h.Value(title),
                    h.Placeholder("A short title"),
                    h.Required(true),
                    h.OnInput((value) => Message.UpdatedTitle({ title: value })),
                  ]),
                ],
              ),
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  fieldLabel("Content", h),
                  h.textarea([
                    h.Class(inputClass),
                    h.Value(content),
                    h.Placeholder("Write the note"),
                    h.Rows(5),
                    h.Required(true),
                    h.OnInput((value) => Message.UpdatedContent({ content: value })),
                  ]),
                ],
              ),
              isLiterature
                ? h.div(
                    [h.Class("flex flex-col gap-1")],
                    [
                      fieldLabel("Reference", h),
                      h.input([
                        h.Class(inputClass),
                        h.Value(reference),
                        h.Placeholder("Book, article, or URL"),
                        h.Required(true),
                        h.OnInput((value) =>
                          Message.UpdatedReference({ reference: value }),
                        ),
                      ]),
                    ],
                  )
                : h.empty,
              h.button(
                [h.Type("submit"), h.Class(primaryButtonClass)],
                ["Save note"],
              ),
            ],
          ),
        ],
      )
    },
    Editing: ({ kind, title, content, reference }) => {
      const isLiterature = kind === "literature"
      return h.form(
        [
          h.Class(panelClass),
          h.OnSubmit(Message.ClickedSavedNote()),
        ],
        [
          h.div(
            [h.Class("mb-4 flex items-center justify-between gap-3")],
            [
              h.h2(
                [h.Class("text-xl font-semibold")],
                [`Edit ${kindLabels[kind].toLowerCase()} note`],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(buttonClass),
                  h.OnClick(Message.ClickedCancelEditor()),
                ],
                ["Cancel"],
              ),
            ],
          ),
          h.div(
            [h.Class("flex flex-col gap-4")],
            [
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  fieldLabel("Title", h),
                  h.input([
                    h.Class(inputClass),
                    h.Value(title),
                    h.Required(true),
                    h.OnInput((value) => Message.UpdatedTitle({ title: value })),
                  ]),
                ],
              ),
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  fieldLabel("Content", h),
                  h.textarea([
                    h.Class(inputClass),
                    h.Value(content),
                    h.Rows(5),
                    h.Required(true),
                    h.OnInput((value) => Message.UpdatedContent({ content: value })),
                  ]),
                ],
              ),
              isLiterature
                ? h.div(
                    [h.Class("flex flex-col gap-1")],
                    [
                      fieldLabel("Reference", h),
                      h.input([
                        h.Class(inputClass),
                        h.Value(reference),
                        h.Required(true),
                        h.OnInput((value) =>
                          Message.UpdatedReference({ reference: value }),
                        ),
                      ]),
                    ],
                  )
                : h.empty,
              h.button(
                [h.Type("submit"), h.Class(primaryButtonClass)],
                ["Save changes"],
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
            [h.Class("flex flex-wrap gap-2")],
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
            [h.Class(panelClass)],
            [
              h.div(
                [h.Class("mb-4 flex items-center justify-between gap-3")],
                [
                  h.h2(
                    [h.Class("text-xl font-semibold")],
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
