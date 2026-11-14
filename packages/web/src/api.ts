import { Note } from "@slipmem/schemas/note"
import { Data, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const NoteDraft = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  reference: Schema.String,
})
export type NoteDraft = typeof NoteDraft.Type

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string
}> {}

const NotesResponse = Schema.Struct({ notes: Schema.Array(Note.Info) })
const NoteResponse = Schema.Struct({ note: Schema.NullOr(Note.Info) })
const DeleteResponse = Schema.Struct({ deleted: Schema.Boolean })

const statusError = (status: number) =>
  new ApiError({ message: `Request failed with status ${status}` })

const ensureOk = (response: { readonly status: number }) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(statusError(response.status))

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
