import {
  FleetingNoteService,
  LiteratureNoteService,
  NoteService,
  PermanentNoteService,
} from "@slipmem/core"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Note } from "@slipmem/schemas/note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Array, Effect, Layer, Match, Option, Order, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

export const NoteDraft = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.optional(Schema.String),
})
export type NoteDraft = typeof NoteDraft.Type

const fromFleeting = (note: FleetingNote.Info): Note.Info => ({
  type: "fleeting",
  ...note,
})

const fromLiterature = (note: LiteratureNote.Info): Note.Info => ({
  type: "literature",
  ...note,
})

const fromPermanent = (note: PermanentNote.Info): Note.Info => ({
  type: "permanent",
  ...note,
})

const json = (body: unknown, status = 200) =>
  HttpServerResponse.json(body, { status })

const invalidRequest = (message: string) => json({ error: message }, 400)

const notFound = (message: string) => json({ error: message }, 404)

const sortByUpdatedAt = (notes: ReadonlyArray<Note.Info>) =>
  Array.sortWith(notes, (note) => note.updatedAt, Order.flip(Order.Number))

const readKind = (value: string | undefined) =>
  Schema.decodeUnknownOption(Note.Kind)(value)

// Validate a draft with the schema for its note kind. The per-kind schemas
// carry the content length limits and the required literature reference, so
// HTTP callers cannot bypass validation that MCP tool inputs enforce.
const decodeDraft = (kind: Note.Kind, body: unknown) =>
  Match.value(kind).pipe(
    Match.when("fleeting", () =>
      Schema.decodeUnknownEffect(FleetingNote.CreateInput)(body)),
    Match.when("permanent", () =>
      Schema.decodeUnknownEffect(PermanentNote.CreateInput)(body)),
    Match.when("literature", () =>
      Schema.decodeUnknownEffect(LiteratureNote.CreateInput)(body)),
    Match.exhaustive,
  )

// Mutating API requests must use JSON. Browsers treat `text/plain` bodies as
// CORS-simple, so accepting them would let another origin write notes with a
// cross-site form-style request. JSON requires a preflight, which this API
// does not allow.
const isJsonContentType = (contentType: string | undefined) =>
  contentType?.toLowerCase().startsWith("application/json") === true

const readDraft = (kind: Note.Kind) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!isJsonContentType(request.headers["content-type"])) {
      return yield* Effect.fail(new Error("Expected an application/json body"))
    }

    const body = yield* request.json
    return yield* decodeDraft(kind, body)
  })

const readBody = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.option)

const makeNoteOperations = (
  fleeting: typeof FleetingNoteService.Service,
  permanent: typeof PermanentNoteService.Service,
  literature: typeof LiteratureNoteService.Service,
) => {
  const create = (kind: Note.Kind, draft: NoteDraft) =>
    Match.value(kind).pipe(
      Match.when("fleeting", () =>
        Effect.gen(function* () {
          const note = yield* fleeting.create({
            title: draft.title,
            content: draft.content,
          })
          return fromFleeting(note)
        })),
      Match.when("permanent", () =>
        Effect.gen(function* () {
          const note = yield* permanent.create({
            title: draft.title,
            content: draft.content,
          })
          return fromPermanent(note)
        })),
      Match.when("literature", () =>
        Effect.gen(function* () {
          const note = yield* literature.create({
            title: draft.title,
            content: draft.content,
            reference: draft.reference ?? "",
          })
          return fromLiterature(note)
        })),
      Match.exhaustive,
    )

  const update = (kind: Note.Kind, id: string, draft: NoteDraft) =>
    Match.value(kind).pipe(
      Match.when("fleeting", () =>
        Effect.gen(function* () {
          const note = yield* fleeting.update({
            id: Schema.decodeUnknownSync(FleetingNote.ID)(id),
            title: draft.title,
            content: draft.content,
          })
          return fromFleeting(note)
        })),
      Match.when("permanent", () =>
        Effect.gen(function* () {
          const note = yield* permanent.update({
            id: Schema.decodeUnknownSync(PermanentNote.ID)(id),
            title: draft.title,
            content: draft.content,
          })
          return fromPermanent(note)
        })),
      Match.when("literature", () =>
        Effect.gen(function* () {
          const note = yield* literature.update({
            id: Schema.decodeUnknownSync(LiteratureNote.ID)(id),
            title: draft.title,
            content: draft.content,
            reference: draft.reference ?? "",
          })
          return fromLiterature(note)
        })),
      Match.exhaustive,
    )

  const get = (kind: Note.Kind, id: string) =>
    Match.value(kind).pipe(
      Match.when("fleeting", () =>
        Effect.gen(function* () {
          const note = yield* fleeting.get({
            id: Schema.decodeUnknownSync(FleetingNote.ID)(id),
          })
          return Option.map(note, fromFleeting)
        })),
      Match.when("permanent", () =>
        Effect.gen(function* () {
          const note = yield* permanent.get({
            id: Schema.decodeUnknownSync(PermanentNote.ID)(id),
          })
          return Option.map(note, fromPermanent)
        })),
      Match.when("literature", () =>
        Effect.gen(function* () {
          const note = yield* literature.get({
            id: Schema.decodeUnknownSync(LiteratureNote.ID)(id),
          })
          return Option.map(note, fromLiterature)
        })),
      Match.exhaustive,
    )

  const remove = (kind: Note.Kind, id: string) =>
    Match.value(kind).pipe(
      Match.when("fleeting", () =>
        fleeting.delete({ id: Schema.decodeUnknownSync(FleetingNote.ID)(id) })),
      Match.when("permanent", () =>
        permanent.delete({ id: Schema.decodeUnknownSync(PermanentNote.ID)(id) })),
      Match.when("literature", () =>
        literature.delete({ id: Schema.decodeUnknownSync(LiteratureNote.ID)(id) })),
      Match.exhaustive,
    )

  return { create, update, get, remove }
}

/**
 * JSON routes for the three note kinds. The aggregate list reads through
 * `NoteService`; writes stay on the per-kind services because each kind has its
 * own input schema.
 *
 * The note services are read while the layer is constructed and closed over by
 * the handlers. That keeps the route requirements to `HttpRouter`, so the same
 * routes work in a server handler and in tests.
 */
export const NoteRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const fleeting = yield* FleetingNoteService
    const permanent = yield* PermanentNoteService
    const literature = yield* LiteratureNoteService
    const notes = yield* NoteService
    const operations = makeNoteOperations(fleeting, permanent, literature)

    const listNotes = Effect.gen(function* () {
      const allNotes = yield* notes.list({})
      return yield* json({ notes: sortByUpdatedAt(allNotes) })
    })

    const listNotesByKind = Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const maybeKind = readKind(params.type)
      if (Option.isNone(maybeKind)) {
        return yield* invalidRequest(`Unknown note type: ${params.type ?? ""}`)
      }

      const allNotes = yield* notes.list({})
      const matchingNotes = Array.filter(
        allNotes,
        (note) => note.type === maybeKind.value,
      )

      return yield* json({ notes: sortByUpdatedAt(matchingNotes) })
    })

    const getNote = Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const maybeKind = readKind(params.type)
      if (Option.isNone(maybeKind)) {
        return yield* invalidRequest(`Unknown note type: ${params.type ?? ""}`)
      }

      const id = params.id
      if (id === undefined) {
        return yield* invalidRequest("Missing note id")
      }

      const note = yield* operations.get(maybeKind.value, id)
      return yield* json({ note: Option.getOrNull(note) })
    })

    const createNote = Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const maybeKind = readKind(params.type)
      if (Option.isNone(maybeKind)) {
        return yield* invalidRequest(`Unknown note type: ${params.type ?? ""}`)
      }

      const maybeDraft = yield* readBody(readDraft(maybeKind.value))
      if (Option.isNone(maybeDraft)) {
        return yield* invalidRequest("Invalid note body")
      }

      const note = yield* operations.create(maybeKind.value, maybeDraft.value)
      return yield* json(note, 201)
    })

    const updateNote = Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const maybeKind = readKind(params.type)
      if (Option.isNone(maybeKind)) {
        return yield* invalidRequest(`Unknown note type: ${params.type ?? ""}`)
      }

      const id = params.id
      if (id === undefined) {
        return yield* invalidRequest("Missing note id")
      }

      const maybeDraft = yield* readBody(readDraft(maybeKind.value))
      if (Option.isNone(maybeDraft)) {
        return yield* invalidRequest("Invalid note body")
      }

      const maybeNote = yield* readBody(
        operations.update(maybeKind.value, id, maybeDraft.value),
      )
      if (Option.isNone(maybeNote)) {
        return yield* notFound(`Note not found: ${id}`)
      }

      return yield* json(maybeNote.value)
    })

    const deleteNote = Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const maybeKind = readKind(params.type)
      if (Option.isNone(maybeKind)) {
        return yield* invalidRequest(`Unknown note type: ${params.type ?? ""}`)
      }

      const id = params.id
      if (id === undefined) {
        return yield* invalidRequest("Missing note id")
      }

      const deleted = yield* operations.remove(maybeKind.value, id)
      return yield* json({ deleted })
    })

    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/health", json({ ok: true, service: "slipmem" })),
      HttpRouter.add("GET", "/api/notes", listNotes),
      HttpRouter.add("GET", "/api/notes/:type", listNotesByKind),
      HttpRouter.add("GET", "/api/notes/:type/:id", getNote),
      HttpRouter.add("POST", "/api/notes/:type", createNote),
      HttpRouter.add("PUT", "/api/notes/:type/:id", updateNote),
      HttpRouter.add("DELETE", "/api/notes/:type/:id", deleteNote),
    )
  }),
)
