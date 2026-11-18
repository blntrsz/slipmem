import { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { LiteratureNote } from "@slipmem/schemas/literature-note"
import { Markdown } from "@slipmem/schemas/markdown"
import { Note } from "@slipmem/schemas/note"
import { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Data, Effect, Option, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"

export const NoteDraft = Note.Draft
export type NoteDraft = typeof NoteDraft.Type

export const NoteType = Markdown.NoteType
export type NoteType = typeof NoteType.Type

const Provenance = Schema.Struct({
  source: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.String),
})

const ApiNoteFields = {
  topics: Schema.Array(Schema.String),
  path: Schema.String,
  contentHash: Schema.String,
  provenance: Schema.optional(Provenance),
} as const

export const ApiFleetingNote = Schema.Struct({
  type: Schema.Literal("fleeting"),
  ...FleetingNote.Info.fields,
  ...ApiNoteFields,
}).annotate({ identifier: "Api.FleetingNote" })

export const ApiLiteratureNote = Schema.Struct({
  type: Schema.Literal("literature"),
  ...LiteratureNote.Info.fields,
  ...ApiNoteFields,
}).annotate({ identifier: "Api.LiteratureNote" })

export const ApiPermanentNote = Schema.Struct({
  type: Schema.Literal("permanent"),
  ...PermanentNote.Info.fields,
  ...ApiNoteFields,
}).annotate({ identifier: "Api.PermanentNote" })

export const ApiNote = Schema.Union([
  ApiFleetingNote,
  ApiLiteratureNote,
  ApiPermanentNote,
])
  .annotate({ identifier: "Api.Note" })
  .pipe(Schema.toTaggedUnion("type"))
export type ApiNote = typeof ApiNote.Type

export const ApiSearchHit = Schema.Struct({
  note: Note.Info,
  id: Schema.String,
  path: Schema.String,
  score: Schema.Finite,
}).annotate({ identifier: "Api.SearchHit" })
export type ApiSearchHit = typeof ApiSearchHit.Type

export const ApiSynthesis = Schema.Struct({
  configured: Schema.Boolean,
  kind: Schema.Literals(["none", "agent", "model"]),
  detail: Schema.String,
}).annotate({ identifier: "Api.Synthesis" })
export type ApiSynthesis = typeof ApiSynthesis.Type

export const ApiTopic = Schema.Struct({
  topic: Schema.String,
  noteCount: Schema.Int,
  byType: Schema.Struct({
    fleeting: Schema.Int,
    literature: Schema.Int,
    permanent: Schema.Int,
  }),
}).annotate({ identifier: "Api.Topic" })
export type ApiTopic = typeof ApiTopic.Type

export const ApiHealth = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
  noteRoot: Schema.String,
  index: Schema.Struct({
    mode: Schema.String,
    path: Schema.String,
    noteCount: Schema.Int,
  }),
  wiki: Schema.Struct({
    synthesis: ApiSynthesis,
  }),
}).annotate({ identifier: "Api.Health" })
export type ApiHealth = typeof ApiHealth.Type

export const ApiPendingProposal = Schema.Struct({
  id: Schema.String,
  operation: Markdown.ApprovalOperation,
  noteId: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  actor: Schema.optional(Schema.String),
  stale: Schema.Boolean,
  expired: Schema.Boolean,
  diff: Schema.String,
  content: Schema.optional(Schema.String),
  currentContent: Schema.optional(Schema.String),
}).annotate({ identifier: "Api.PendingProposal" })
export type ApiPendingProposal = typeof ApiPendingProposal.Type

const NotesResponse = Schema.Struct({ notes: Schema.Array(ApiNote) })
const NoteResponse = Schema.Struct({ note: ApiNote })
const SearchResponse = Schema.Struct({ results: Schema.Array(ApiSearchHit) })
const TopicsResponse = Schema.Struct({ topics: Schema.Array(ApiTopic) })
export const ApiWikiPage = Schema.Struct({
  ...Markdown.WikiPage.fields,
  synthesis: ApiSynthesis,
}).annotate({ identifier: "Api.WikiPage" })
export type ApiWikiPage = typeof ApiWikiPage.Type
const PendingResponse = Schema.Struct({
  proposals: Schema.Array(ApiPendingProposal),
  invalid: Schema.Array(
    Schema.Struct({ code: Schema.String, message: Schema.String }),
  ),
})
const ErrorResponse = Schema.Struct({
  error: Schema.String,
  code: Schema.optional(Schema.String),
})

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string
  readonly status: number
}> {}

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
      onNone: () => `Request failed with status ${response.status}`,
      onSome: ({ error }) => error,
    })

    return yield* Effect.fail(
      new ApiError({ message, status: response.status }),
    )
  })

export const apiErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback

const decodeResponse = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    yield* ensureOk(response)
    const body = yield* response.json
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new ApiError({
            message: "The server returned an unexpected response.",
            status: response.status,
          }),
      ),
    )
  })

const sendJson = <S extends Schema.ConstraintDecoder<unknown>>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    return yield* decodeResponse(schema, response)
  })

const query = (
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value))
    }
  }
  const suffix = search.toString()
  return suffix === "" ? path : `${path}?${suffix}`
}

export interface ListNotesInput {
  readonly type?: NoteType
  readonly topic?: string
  readonly limit?: number
}

export const listNotes = (input: ListNotesInput = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query("/api/notes", {
        type: input.type,
        topic: input.topic,
        limit: input.limit,
      }),
    )
    const body = yield* decodeResponse(NotesResponse, response)
    return body.notes
  })

export const getNote = (id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`/api/notes/${encodeURIComponent(id)}`)
    const body = yield* decodeResponse(NoteResponse, response)
    return body.note
  })

export const createNote = (type: NoteType, draft: NoteDraft) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("/api/notes"),
      { type, ...draft },
    )
    const body = yield* sendJson(request, NoteResponse)
    return body.note
  })

export const updateNote = (id: string, draft: NoteDraft) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.put(`/api/notes/${encodeURIComponent(id)}`),
      draft,
    )
    const body = yield* sendJson(request, NoteResponse)
    return body.note
  })

export const deleteNote = (id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.make("DELETE")(
      `/api/notes/${encodeURIComponent(id)}`,
    )
    const response = yield* client.execute(request)
    yield* ensureOk(response)
    const body = (yield* response.json) as { readonly deleted?: boolean }
    return body.deleted === true
  })

export interface SearchNotesInput {
  readonly query: string
  readonly type?: NoteType
  readonly topic?: string
  readonly limit?: number
}

export const searchNotes = (input: SearchNotesInput) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query("/api/search", {
        q: input.query,
        type: input.type,
        topic: input.topic,
        limit: input.limit,
      }),
    )
    const body = yield* decodeResponse(SearchResponse, response)
    return body.results
  })

export const listTopics = (limit?: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(query("/api/topics", { limit }))
    const body = yield* decodeResponse(TopicsResponse, response)
    return body.topics
  })

export const getWiki = (
  topic: string,
  options: {
    readonly mode?: Markdown.WikiMode
    readonly limit?: number
    readonly includeFleeting?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query(`/api/wiki/${encodeURIComponent(topic)}`, {
        mode: options.mode,
        limit: options.limit,
        includeFleeting: options.includeFleeting === true ? "true" : undefined,
      }),
    )
    return yield* decodeResponse(ApiWikiPage, response)
  })

export const listPending = () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get("/api/pending")
    return yield* decodeResponse(PendingResponse, response)
  })

export const approveProposal = (proposalId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(
        `/api/pending/${encodeURIComponent(proposalId)}/approve`,
      ),
    )
    yield* ensureOk(response)
    return yield* response.json
  })

export const rejectProposal = (proposalId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(
        `/api/pending/${encodeURIComponent(proposalId)}/reject`,
      ),
    )
    yield* ensureOk(response)
    return yield* response.json
  })

export const getHealth = () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get("/api/health")
    return yield* decodeResponse(ApiHealth, response)
  })
