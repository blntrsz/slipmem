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
  tags: Schema.Array(Schema.String),
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

export const ApiTag = Schema.Struct({
  tag: Schema.String,
  noteCount: Schema.Int,
  byType: Schema.Struct({
    fleeting: Schema.Int,
    literature: Schema.Int,
    permanent: Schema.Int,
  }),
}).annotate({ identifier: "Api.Tag" })
export type ApiTag = typeof ApiTag.Type

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
const TagsResponse = Schema.Struct({ tags: Schema.Array(ApiTag) })
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
const DeleteResponse = Schema.Struct({
  deleted: Schema.Literal(true),
  id: Schema.String,
})
const ApproveResponse = Schema.Struct({
  status: Schema.Literal("applied"),
  proposalId: Schema.String,
  noteId: Schema.String,
})
const RejectResponse = Schema.Struct({
  status: Schema.Literal("rejected"),
  proposalId: Schema.String,
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

const unexpectedResponse = (status: number): ApiError =>
  new ApiError({
    message: "The server returned an unexpected response.",
    status,
  })

/**
 * A mutation holds an in-flight guard in the UI model until its command
 * settles, so a request that never answers must not hold that guard forever.
 * The bound fails the command with an ordinary `ApiError`, which releases the
 * guard through the normal failure path. It never retries: a write that timed
 * out may already have been applied.
 */
const MUTATION_TIMEOUT_MS = 30_000
const MUTATION_TIMEOUT_SECONDS = MUTATION_TIMEOUT_MS / 1_000

const mutationTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ApiError, R> =>
  Effect.flatMap(Effect.timeoutOption(effect, MUTATION_TIMEOUT_MS), (result) =>
    Option.match(result, {
      onNone: () =>
        Effect.fail(
          new ApiError({
            message: `The server did not respond within ${MUTATION_TIMEOUT_SECONDS} seconds. The change may not have been applied.`,
            status: 408,
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    }),
  )

const decodeResponse = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    yield* ensureOk(response)
    const body = yield* response.json
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => unexpectedResponse(response.status)),
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
  readonly tag?: string
  readonly limit?: number
}

export const listNotes = (input: ListNotesInput = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query("/api/notes", {
        type: input.type,
        tag: input.tag,
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
  mutationTimeout(
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/api/notes"),
        { type, ...draft },
      )
      const body = yield* sendJson(request, NoteResponse)
      return body.note
    }),
  )

export const updateNote = (
  id: string,
  draft: NoteDraft,
  expectedContentHash?: string,
) =>
  mutationTimeout(
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.put(`/api/notes/${encodeURIComponent(id)}`),
        draft,
      )
      const conditional =
        expectedContentHash === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              "if-match",
              `"${expectedContentHash}"`,
            )
      const body = yield* sendJson(conditional, NoteResponse)
      return body.note
    }),
  )

export const deleteNote = (id: string, expectedContentHash?: string) =>
  mutationTimeout(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const request = HttpClientRequest.make("DELETE")(
        `/api/notes/${encodeURIComponent(id)}`,
      )
      const conditional =
        expectedContentHash === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              "if-match",
              `"${expectedContentHash}"`,
            )
      const response = yield* client.execute(conditional)
      const body = yield* decodeResponse(DeleteResponse, response)
      if (body.id !== id) {
        return yield* Effect.fail(unexpectedResponse(response.status))
      }
      return body.deleted
    }),
  )

export interface SearchNotesInput {
  readonly query: string
  readonly type?: NoteType
  readonly tag?: string
  readonly limit?: number
}

export const searchNotes = (input: SearchNotesInput) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query("/api/search", {
        q: input.query,
        type: input.type,
        tag: input.tag,
        limit: input.limit,
      }),
    )
    const body = yield* decodeResponse(SearchResponse, response)
    return body.results
  })

export const listTags = (limit?: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(query("/api/tags", { limit }))
    const body = yield* decodeResponse(TagsResponse, response)
    return body.tags
  })

export const getWiki = (
  tag: string,
  options: {
    readonly mode?: Markdown.WikiMode
    readonly limit?: number
    readonly includeFleeting?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(
      query(`/api/wiki/${encodeURIComponent(tag)}`, {
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
  mutationTimeout(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(
          `/api/pending/${encodeURIComponent(proposalId)}/approve`,
        ),
      )
      const body = yield* decodeResponse(ApproveResponse, response)
      if (body.proposalId !== proposalId) {
        return yield* Effect.fail(unexpectedResponse(response.status))
      }
      return body
    }),
  )

export const rejectProposal = (proposalId: string) =>
  mutationTimeout(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(
          `/api/pending/${encodeURIComponent(proposalId)}/reject`,
        ),
      )
      const body = yield* decodeResponse(RejectResponse, response)
      if (body.proposalId !== proposalId) {
        return yield* Effect.fail(unexpectedResponse(response.status))
      }
      return body
    }),
  )

export const getHealth = () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get("/api/health")
    return yield* decodeResponse(ApiHealth, response)
  })
