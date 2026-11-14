import { Note } from "@slipmem/schemas/note"
import { Data, Effect, Option, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"

// The wire shape is shared with the server. It describes the fields the editor
// sends; per-kind rules (required text, content limits, literature reference)
// are still applied against the matching schema before sending.
export const NoteDraft = Note.Draft
export type NoteDraft = typeof NoteDraft.Type

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string
}> {}

const NotesResponse = Schema.Struct({ notes: Schema.Array(Note.Info) })
const NoteResponse = Schema.Struct({ note: Schema.NullOr(Note.Info) })
const DeleteResponse = Schema.Struct({ deleted: Schema.Boolean })
const ErrorResponse = Schema.Struct({ error: Schema.String })

const statusError = (status: number) =>
  new ApiError({ message: `Request failed with status ${status}` })

/**
 * Turns any failure from this module into a message suitable for the UI. The
 * JSON API returns `{ error }` for rejected requests, so callers can show the
 * server's validation message instead of a generic failure.
 */
export const apiErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback

const ensureOk = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status >= 200 && response.status < 300) {
      return
    }

    const body = yield* Effect.option(response.json)
    const parsed = Option.flatMap(body, (value) =>
      Schema.decodeUnknownOption(ErrorResponse)(value),
    )
    const message = Option.match(parsed, {
      onNone: () => statusError(response.status).message,
      onSome: ({ error }) => error,
    })

    return yield* Effect.fail(new ApiError({ message }))
  })

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    yield* ensureOk(response)
    return yield* response.json
  })

const withJsonBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
) => HttpClientRequest.bodyJson(request, body)

export const listNotes = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("/api/notes")
  yield* ensureOk(response)
  const decoded = yield* Schema.decodeUnknownEffect(NotesResponse)(yield* response.json)
  return decoded.notes
})

export const createNote = (type: Note.Kind, draft: NoteDraft) =>
  Effect.gen(function* () {
    const request = yield* withJsonBody(
      HttpClientRequest.post(`/api/notes/${type}`),
      draft,
    )
    const body = yield* send(request)
    return yield* Schema.decodeUnknownEffect(Note.Info)(body)
  })

export const updateNote = (type: Note.Kind, id: string, draft: NoteDraft) =>
  Effect.gen(function* () {
    const request = yield* withJsonBody(
      HttpClientRequest.put(`/api/notes/${type}/${encodeURIComponent(id)}`),
      draft,
    )
    const body = yield* send(request)
    return yield* Schema.decodeUnknownEffect(Note.Info)(body)
  })

export const getNote = (type: Note.Kind, id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      `/api/notes/${type}/${encodeURIComponent(id)}`,
    )
    yield* ensureOk(response)
    const decoded = yield* Schema.decodeUnknownEffect(NoteResponse)(yield* response.json)
    return decoded.note
  })

export const deleteNote = (type: Note.Kind, id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.delete(`/api/notes/${type}/${encodeURIComponent(id)}`),
    )
    yield* ensureOk(response)
    const decoded = yield* Schema.decodeUnknownEffect(DeleteResponse)(yield* response.json)
    return decoded.deleted
  })
