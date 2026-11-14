import {
  FleetingNoteNotFound,
  FleetingNoteService,
  LiteratureNoteNotFound,
  LiteratureNoteService,
  PermanentNoteNotFound,
  PermanentNoteService,
} from "@slipmem/core"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Effect, Layer, Option, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"

// A declared failure is returned to the MCP client as a tool error instead of
// crashing the request. The id makes the failure actionable for the caller.
const NoteNotFoundFailure = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
})

// Annotations tell MCP clients that all tools operate on a local database and
// that only delete tools destroy data.
const localTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false).annotate(Tool.Destructive, false) as T

const readOnlyTool = <T extends Tool.Any>(tool: T): T =>
  localTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T

const ListFleetingNotes = readOnlyTool(Tool.make("list_fleeting_notes", {
  description: "List every fleeting note.",
  success: Schema.Struct({ notes: Schema.Array(FleetingNote.Info) }),
}))

const GetFleetingNote = readOnlyTool(Tool.make("get_fleeting_note", {
  description: "Read a fleeting note by id.",
  parameters: FleetingNote.GetInput,
  success: Schema.Struct({ note: Schema.NullOr(FleetingNote.Info) }),
}))

const CreateFleetingNote = localTool(Tool.make("create_fleeting_note", {
  description: "Create a fleeting note.",
  parameters: FleetingNote.CreateInput,
  success: FleetingNote.Info,
}))

const UpdateFleetingNote = localTool(Tool.make("update_fleeting_note", {
  description: "Replace the title and content of a fleeting note by id.",
  parameters: FleetingNote.UpdateInput,
  success: FleetingNote.Info,
  failure: NoteNotFoundFailure,
}))

const DeleteFleetingNote = localTool(Tool.make("delete_fleeting_note", {
  description: "Delete a fleeting note by id. Returns whether a note was deleted.",
  parameters: FleetingNote.DeleteInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
})).annotate(Tool.Idempotent, true).annotate(Tool.Destructive, true)

const ListPermanentNotes = readOnlyTool(Tool.make("list_permanent_notes", {
  description: "List every permanent note.",
  success: Schema.Struct({ notes: Schema.Array(PermanentNote.Info) }),
}))

const GetPermanentNote = readOnlyTool(Tool.make("get_permanent_note", {
  description: "Read a permanent note by id.",
  parameters: PermanentNote.GetInput,
  success: Schema.Struct({ note: Schema.NullOr(PermanentNote.Info) }),
}))

const CreatePermanentNote = localTool(Tool.make("create_permanent_note", {
  description: "Create a permanent note.",
  parameters: PermanentNote.CreateInput,
  success: PermanentNote.Info,
}))

const UpdatePermanentNote = localTool(Tool.make("update_permanent_note", {
  description: "Replace the title and content of a permanent note by id.",
  parameters: PermanentNote.UpdateInput,
  success: PermanentNote.Info,
  failure: NoteNotFoundFailure,
}))

const DeletePermanentNote = localTool(Tool.make("delete_permanent_note", {
  description: "Delete a permanent note by id. Returns whether a note was deleted.",
  parameters: PermanentNote.DeleteInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
})).annotate(Tool.Idempotent, true).annotate(Tool.Destructive, true)

const ListLiteratureNotes = readOnlyTool(Tool.make("list_literature_notes", {
  description: "List every literature note.",
  success: Schema.Struct({ notes: Schema.Array(LiteratureNote.Info) }),
}))

const GetLiteratureNote = readOnlyTool(Tool.make("get_literature_note", {
  description: "Read a literature note by id.",
  parameters: LiteratureNote.GetInput,
  success: Schema.Struct({ note: Schema.NullOr(LiteratureNote.Info) }),
}))

const CreateLiteratureNote = localTool(Tool.make("create_literature_note", {
  description: "Create a literature note with a source reference.",
  parameters: LiteratureNote.CreateInput,
  success: LiteratureNote.Info,
}))

const UpdateLiteratureNote = localTool(Tool.make("update_literature_note", {
  description: "Replace the title, content, and reference of a literature note by id.",
  parameters: LiteratureNote.UpdateInput,
  success: LiteratureNote.Info,
  failure: NoteNotFoundFailure,
}))

const DeleteLiteratureNote = localTool(Tool.make("delete_literature_note", {
  description: "Delete a literature note by id. Returns whether a note was deleted.",
  parameters: LiteratureNote.DeleteInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
})).annotate(Tool.Idempotent, true).annotate(Tool.Destructive, true)

export const NoteTools = Toolkit.make(
  ListFleetingNotes,
  GetFleetingNote,
  CreateFleetingNote,
  UpdateFleetingNote,
  DeleteFleetingNote,
  ListPermanentNotes,
  GetPermanentNote,
  CreatePermanentNote,
  UpdatePermanentNote,
  DeletePermanentNote,
  ListLiteratureNotes,
  GetLiteratureNote,
  CreateLiteratureNote,
  UpdateLiteratureNote,
  DeleteLiteratureNote,
)

const noteNotFound = (id: string, kind: string) => ({
  id,
  message: `${kind} not found: ${id}`,
})

/**
 * Builds tool handlers from the note services. The services are read while
 * the layer is constructed and closed over by the handlers, so the same
 * registrations work with a file-backed database in production and with
 * `":memory:"` in tests.
 */
export const NoteHandlersLayer = NoteTools.toLayer(
  Effect.gen(function* () {
    const fleeting = yield* FleetingNoteService
    const permanent = yield* PermanentNoteService
    const literature = yield* LiteratureNoteService

    return NoteTools.of({
      list_fleeting_notes: () => fleeting.list({}).pipe(Effect.map((notes) => ({ notes }))),
      get_fleeting_note: (input) =>
        fleeting.get(input).pipe(Effect.map((note) => ({ note: Option.getOrNull(note) }))),
      create_fleeting_note: (input) => fleeting.create(input),
      update_fleeting_note: (input) =>
        fleeting.update(input).pipe(
          Effect.catchTag("FleetingNoteNotFound", (error: FleetingNoteNotFound) =>
            Effect.fail(noteNotFound(error.id, "Fleeting note")),
          ),
        ),
      delete_fleeting_note: (input) =>
        fleeting.delete(input).pipe(Effect.map((deleted) => ({ deleted }))),

      list_permanent_notes: () => permanent.list({}).pipe(Effect.map((notes) => ({ notes }))),
      get_permanent_note: (input) =>
        permanent.get(input).pipe(Effect.map((note) => ({ note: Option.getOrNull(note) }))),
      create_permanent_note: (input) => permanent.create(input),
      update_permanent_note: (input) =>
        permanent.update(input).pipe(
          Effect.catchTag("PermanentNoteNotFound", (error: PermanentNoteNotFound) =>
            Effect.fail(noteNotFound(error.id, "Permanent note")),
          ),
        ),
      delete_permanent_note: (input) =>
        permanent.delete(input).pipe(Effect.map((deleted) => ({ deleted }))),

      list_literature_notes: () => literature.list({}).pipe(Effect.map((notes) => ({ notes }))),
      get_literature_note: (input) =>
        literature.get(input).pipe(Effect.map((note) => ({ note: Option.getOrNull(note) }))),
      create_literature_note: (input) => literature.create(input),
      update_literature_note: (input) =>
        literature.update(input).pipe(
          Effect.catchTag("LiteratureNoteNotFound", (error: LiteratureNoteNotFound) =>
            Effect.fail(noteNotFound(error.id, "Literature note")),
          ),
        ),
      delete_literature_note: (input) =>
        literature.delete(input).pipe(Effect.map((deleted) => ({ deleted }))),
    })
  }),
)

/**
 * Registers every note tool with `McpServer`. The layer requires the three
 * note services, which the server layer satisfies with its database.
 */
export const NoteRegistrations = McpServer.toolkit(NoteTools).pipe(
  Layer.provide(NoteHandlersLayer),
)
