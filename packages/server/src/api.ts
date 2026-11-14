import {
  FleetingNoteNotFound,
  FleetingNoteService,
  LiteratureNoteNotFound,
  LiteratureNoteService,
  NoteService,
  PermanentNoteNotFound,
  PermanentNoteService,
} from "@slipmem/core"
import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Note } from "@slipmem/schemas/note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Array, Data, Effect, Layer, Match, Option, Order, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

// Keep the exported name for existing callers, but use the shared wire shape so
// the web client and the API cannot drift on draft fields.
export const NoteDraft = Note.Draft
export type NoteDraft = typeof NoteDraft.Type

export class InvalidNoteType extends Data.TaggedError("InvalidNoteType")<{
  readonly type: string | undefined
}> {}

export class InvalidNoteId extends Data.TaggedError("InvalidNoteId")<{
  readonly kind: Note.Kind
  readonly id: string | undefined
}> {}

export class InvalidNoteBody extends Data.TaggedError("InvalidNoteBody")<{
  readonly reason: string
}> {}

export class NoteNotFound extends Data.TaggedError("NoteNotFound")<{
  readonly id: string
}> {}

type ApiError =
  | InvalidNoteType
  | InvalidNoteId
  | InvalidNoteBody
  | NoteNotFound

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
  HttpServerResponse.jsonUnsafe(body, { status })

const errorResponse = (error: ApiError): HttpServerResponse.HttpServerResponse =>
  Match.value(error).pipe(
    Match.tag("InvalidNoteType", ({ type }) =>
      json({ error: `Unknown note type: ${type ?? ""}` }, 400)),
    Match.tag("InvalidNoteId", ({ id }) =>
      json(
        { error: id === undefined ? "Missing note id" : `Invalid note id: ${id}` },
        400,
      )),
    Match.tag("InvalidNoteBody", ({ reason }) =>
      json({ error: reason }, 400)),
    Match.tag("NoteNotFound", ({ id }) =>
      json({ error: `Note not found: ${id}` }, 404)),
    Match.exhaustive,
  )

// Newest first, then kind and id. Ids are only unique within a note table, so
// the tie-breaker must include both the kind and the id to keep responses
// deterministic when timestamps collide.
const noteOrder = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (note: Note.Info) => note.updatedAt),
  Order.mapInput(
    Order.String,
    (note: Note.Info) => `${note.type}\u0000${note.id}`,
  ),
)

const sortByUpdatedAt = (notes: ReadonlyArray<Note.Info>) =>
  Array.sort(notes, noteOrder)

const decodeKind = (value: string | undefined) =>
  Schema.decodeUnknownEffect(Note.Kind)(value).pipe(
    Effect.mapError(() => new InvalidNoteType({ type: value })),
  )

// The per-kind ID schemas are brands over strings. Decoding through the
// supplied schema keeps the branded result without a throwing
// `decodeUnknownSync` inside an Effect generator.
const decodeNoteId = <S extends Schema.ConstraintDecoder<unknown>>(
  kind: Note.Kind,
  id: string | undefined,
  schema: S,
): Effect.Effect<S["Type"], InvalidNoteId> => {
  if (id === undefined) {
    return Effect.fail(new InvalidNoteId({ kind, id }))
  }

  const decoded = Schema.decodeUnknownOption(schema)(id)
  return Option.isNone(decoded)
    ? Effect.fail(new InvalidNoteId({ kind, id }))
    : Effect.succeed(decoded.value)
}

// Validate a draft with the schema for its note kind and operation. The
// per-kind schemas carry the content length limits and the required literature
// reference, so HTTP callers cannot bypass validation that MCP tool inputs
// enforce. Updates reuse the path id while validating the writable fields, so
// a body cannot smuggle in a different note id.
const createDraftSchema = (kind: Note.Kind) =>
  Match.value(kind).pipe(
    Match.when("fleeting", () => FleetingNote.CreateInput),
    Match.when("permanent", () => PermanentNote.CreateInput),
    Match.when("literature", () => LiteratureNote.CreateInput),
    Match.exhaustive,
  )

const updateDraftSchema = (kind: Note.Kind) =>
  Match.value(kind).pipe(
    Match.when("fleeting", () => FleetingNote.UpdateInput),
    Match.when("permanent", () => PermanentNote.UpdateInput),
    Match.when("literature", () => LiteratureNote.UpdateInput),
    Match.exhaustive,
  )

const withNoteId = (body: unknown, id: string): unknown =>
  typeof body === "object" && body !== null && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), id }
    : body

// Keep the schema's human-readable summary and its field path, flattened onto
// one line. The path makes a missing or mistyped field actionable without
// exposing the full stack-like issue tree in an HTTP response.
const validationReason = (message: string): string => {
  const [summary = "Invalid note body", ...details] = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return details.length > 0 ? `${summary} (${details.join(" ")})` : summary
}

const decodeDraft = (kind: Note.Kind, body: unknown, id?: string) => {
  const result =
    id === undefined
      ? Schema.decodeUnknownEffect(createDraftSchema(kind))(body)
      : Schema.decodeUnknownEffect(updateDraftSchema(kind))(
          withNoteId(body, id),
        )

  return result.pipe(
    Effect.mapError(
      (error) =>
        new InvalidNoteBody({ reason: validationReason(error.message) }),
    ),
  )
}

// Mutating API requests must use JSON. Browsers treat `text/plain` bodies as
// CORS-simple, so accepting them would let another origin write notes with a
// cross-site form-style request. JSON requires a preflight, which this API
// does not allow.
const isJsonContentType = (contentType: string | undefined) =>
  contentType?.toLowerCase().startsWith("application/json") === true

const readDraft = (kind: Note.Kind, id?: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!isJsonContentType(request.headers["content-type"])) {
      return yield* Effect.fail(
        new InvalidNoteBody({ reason: "Expected an application/json body" }),
      )
    }

    const body = yield* request.json.pipe(
      Effect.mapError(
        () => new InvalidNoteBody({ reason: "Invalid note body" }),
      ),
    )
    return yield* decodeDraft(kind, body, id)
  })

interface NoteOperations {
  readonly create: (draft: NoteDraft) => Effect.Effect<Note.Info>
  readonly get: (
    id: string | undefined,
  ) => Effect.Effect<Option.Option<Note.Info>, InvalidNoteId>
  readonly update: (
    id: string | undefined,
    draft: NoteDraft,
  ) => Effect.Effect<Note.Info, InvalidNoteId | NoteNotFound>
  readonly remove: (
    id: string | undefined,
  ) => Effect.Effect<boolean, InvalidNoteId>
}

const makeNoteOperations = (
  fleeting: typeof FleetingNoteService.Service,
  permanent: typeof PermanentNoteService.Service,
  literature: typeof LiteratureNoteService.Service,
): Readonly<Record<Note.Kind, NoteOperations>> => ({
  fleeting: {
    create: (draft) =>
      fleeting.create({ title: draft.title, content: draft.content }).pipe(
        Effect.map(fromFleeting),
      ),
    get: (id) =>
      Effect.gen(function* () {
        const note = yield* fleeting.get({ id: yield* decodeNoteId("fleeting", id, FleetingNote.ID) })
        return Option.map(note, fromFleeting)
      }),
    update: (id, draft) =>
      Effect.gen(function* () {
        const decodedId = yield* decodeNoteId("fleeting", id, FleetingNote.ID)
        const note = yield* fleeting.update({
          id: decodedId,
          title: draft.title,
          content: draft.content,
        }).pipe(
          Effect.catchTag("FleetingNoteNotFound", (error: FleetingNoteNotFound) =>
            Effect.fail(new NoteNotFound({ id: error.id })),
          ),
        )
        return fromFleeting(note)
      }),
    remove: (id) =>
      Effect.gen(function* () {
        return yield* fleeting.delete({ id: yield* decodeNoteId("fleeting", id, FleetingNote.ID) })
      }),
  },
  permanent: {
    create: (draft) =>
      permanent.create({ title: draft.title, content: draft.content }).pipe(
        Effect.map(fromPermanent),
      ),
    get: (id) =>
      Effect.gen(function* () {
        const note = yield* permanent.get({ id: yield* decodeNoteId("permanent", id, PermanentNote.ID) })
        return Option.map(note, fromPermanent)
      }),
    update: (id, draft) =>
      Effect.gen(function* () {
        const decodedId = yield* decodeNoteId("permanent", id, PermanentNote.ID)
        const note = yield* permanent.update({
          id: decodedId,
          title: draft.title,
          content: draft.content,
        }).pipe(
          Effect.catchTag("PermanentNoteNotFound", (error: PermanentNoteNotFound) =>
            Effect.fail(new NoteNotFound({ id: error.id })),
          ),
        )
        return fromPermanent(note)
      }),
    remove: (id) =>
      Effect.gen(function* () {
        return yield* permanent.delete({ id: yield* decodeNoteId("permanent", id, PermanentNote.ID) })
      }),
  },
  literature: {
    create: (draft) =>
      literature.create({
        title: draft.title,
        content: draft.content,
        reference: draft.reference ?? "",
      }).pipe(Effect.map(fromLiterature)),
    get: (id) =>
      Effect.gen(function* () {
        const note = yield* literature.get({ id: yield* decodeNoteId("literature", id, LiteratureNote.ID) })
        return Option.map(note, fromLiterature)
      }),
    update: (id, draft) =>
      Effect.gen(function* () {
        const decodedId = yield* decodeNoteId("literature", id, LiteratureNote.ID)
        const note = yield* literature.update({
          id: decodedId,
          title: draft.title,
          content: draft.content,
          reference: draft.reference ?? "",
        }).pipe(
          Effect.catchTag("LiteratureNoteNotFound", (error: LiteratureNoteNotFound) =>
            Effect.fail(new NoteNotFound({ id: error.id })),
          ),
        )
        return fromLiterature(note)
      }),
    remove: (id) =>
      Effect.gen(function* () {
        return yield* literature.delete({ id: yield* decodeNoteId("literature", id, LiteratureNote.ID) })
      }),
  },
})

const route = <E extends ApiError, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(error))),
  )

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

    const listNotes = route(
      Effect.gen(function* () {
        const allNotes = yield* notes.list({})
        return json({ notes: sortByUpdatedAt(allNotes) })
      }),
    )

    const listNotesByKind = route(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const kind = yield* decodeKind(params.type)

        const allNotes = yield* notes.list({})
        const matchingNotes = Array.filter(
          allNotes,
          (note) => note.type === kind,
        )

        return json({ notes: sortByUpdatedAt(matchingNotes) })
      }),
    )

    const getNote = route(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const kind = yield* decodeKind(params.type)
        const note = yield* operations[kind].get(params.id)
        return json({ note: Option.getOrNull(note) })
      }),
    )

    const createNote = route(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const kind = yield* decodeKind(params.type)
        const draft = yield* readDraft(kind)
        const note = yield* operations[kind].create(draft)
        return json(note, 201)
      }),
    )

    const updateNote = route(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const kind = yield* decodeKind(params.type)
        const draft = yield* readDraft(kind, params.id)
        const note = yield* operations[kind].update(params.id, draft)
        return json(note)
      }),
    )

    const deleteNote = route(
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const kind = yield* decodeKind(params.type)
        const deleted = yield* operations[kind].remove(params.id)
        return json({ deleted })
      }),
    )

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
