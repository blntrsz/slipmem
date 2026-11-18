import { Markdown } from "@slipmem/schemas/markdown"
import { Note as NoteSchema } from "@slipmem/schemas/note"
import {
  ApprovalError,
  ApprovalService,
  DEFAULT_LIST_LIMIT,
  MarkdownError,
  MarkdownNoteRepository,
  MarkdownSearchIndex,
  MAX_SEARCH_QUERY_LENGTH,
  WikiError,
  WikiService,
  resolveSynthesisSelection,
  type MarkdownNoteRepositoryShape,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Data, Effect, Layer, Match, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { toApiNote } from "./markdown"

// The wire shape shared by the web client and the API. Per-kind rules
// (content limits, literature reference) are enforced by the Markdown
// repository, which is the same code path used by the CLI and MCP surfaces.
export const NoteDraft = NoteSchema.Draft
export type NoteDraft = typeof NoteDraft.Type

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number
  readonly code: string
  readonly message: string
}> {}

const fail = (status: number, code: string, message: string) =>
  Effect.fail(new ApiError({ status, code, message }))

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })

const errorResponse = (error: ApiError) =>
  json(
    { error: error.message, code: error.code },
    error.status,
  )

const markdownStatus = (error: MarkdownError): number =>
  Match.value(error.code).pipe(
    Match.when("not-found", () => 404),
    Match.when("repository-root-missing", () => 503),
    Match.when("repository-locked", () => 409),
    Match.when("file-too-large", () => 413),
    Match.when("frontmatter-too-large", () => 413),
    Match.when("write-failed", () => 500),
    Match.when("backup-failed", () => 500),
    Match.when("index-error", () => 500),
    Match.when("index-schema", () => 500),
    Match.orElse(() => 400),
  )

const fromMarkdownError = (error: MarkdownError): ApiError =>
  new ApiError({
    status: markdownStatus(error),
    code: error.code,
    message: error.field === undefined
      ? error.message
      : `${error.message} (${error.field})`,
  })

const approvalStatus = (error: ApprovalError): number =>
  Match.value(error.code).pipe(
    Match.when("proposal-not-found", () => 404),
    Match.when("target-missing", () => 404),
    Match.when("proposal-expired", () => 409),
    Match.when("stale-base", () => 409),
    Match.when("target-exists", () => 409),
    Match.when("proposal-id-conflict", () => 409),
    Match.when("proposal-queue-full", () => 429),
    Match.when("proposal-write-failed", () => 500),
    Match.when("proposal-read-failed", () => 500),
    Match.when("repository-failure", () => 500),
    Match.when("apply-failed", () => 500),
    Match.orElse(() => 400),
  )

const fromApprovalError = (error: ApprovalError): ApiError =>
  new ApiError({
    status: approvalStatus(error),
    code: error.code,
    message: error.field === undefined
      ? error.message
      : `${error.message} (${error.field})`,
  })

const fromWikiError = (error: WikiError): ApiError =>
  new ApiError({
    status:
      error.code === "repository-failure"
        ? 500
        : error.code === "synthesis-config" ||
            error.code === "synthesis-adapter-unsupported"
          ? 501
          : 400,
    code: error.code,
    message: error.field === undefined
      ? error.message
      : `${error.message} (${error.field})`,
  })

/**
 * What the running server can actually do for synthesized wiki pages.
 *
 * The capability is derived from the same resolver `WikiService` uses, so the
 * UI never advertises a mode this process cannot resolve. An agent is reported
 * as configured (not guaranteed): the core service still refuses to run it
 * without a working OS sandbox unless the operator opts into the unsafe mode.
 */
export interface SynthesisCapability {
  readonly configured: boolean
  readonly kind: "none" | "agent" | "model"
  readonly detail: string
}

const synthesisCapability = (
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<SynthesisCapability> =>
  resolveSynthesisSelection(env).pipe(
    Effect.map(({ selection }): SynthesisCapability => {
      if (selection.kind === "extractive") {
        return {
          configured: false,
          kind: "none",
          detail:
            "Extractive mode is the default. Set SLIPMEM_WIKI_SYNTHESIS=agent and SLIPMEM_WIKI_AGENT to configure a local synthesizer.",
        }
      }
      if (selection.kind === "agent") {
        return {
          configured: true,
          kind: "agent",
          detail:
            "A local synthesis agent is configured. It runs only through a probed OS sandbox unless SLIPMEM_WIKI_AGENT_UNSAFE=1 explicitly accepts the risk.",
        }
      }
      return {
        configured: false,
        kind: "model",
        detail: `Model ID '${selection.modelId}' has no registered adapter in this server. Configure a local agent or use extractive mode.`,
      }
    }),
    Effect.catch((error) =>
      Effect.succeed({
        configured: false,
        kind: "none" as const,
        detail: `Synthesis is misconfigured: ${error.message}`,
      }),
    ),
  )

const route = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    ApiError | MarkdownError | ApprovalError | WikiError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      ApiError: (error) => Effect.succeed(errorResponse(error)),
      MarkdownError: (error) =>
        Effect.succeed(errorResponse(fromMarkdownError(error))),
      ApprovalError: (error) =>
        Effect.succeed(errorResponse(fromApprovalError(error))),
      WikiError: (error) =>
        Effect.succeed(errorResponse(fromWikiError(error))),
    }),
  )

const requestUrl = (request: HttpServerRequest.HttpServerRequest): URL =>
  new URL(request.url, "http://localhost")

const queryValue = (url: URL, key: string): string | undefined => {
  const value = url.searchParams.get(key)
  return value === null || value === "" ? undefined : value
}

const parseLimit = (
  url: URL,
): Effect.Effect<number | undefined, ApiError> => {
  const raw = queryValue(url, "limit")
  if (raw === undefined) {
    return Effect.succeed(undefined)
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fail(400, "invalid-limit", "limit must be a positive integer.")
  }
  return Effect.succeed(value)
}

const parseType = (
  value: unknown,
): Effect.Effect<Markdown.NoteType, ApiError> =>
  Schema.decodeUnknownEffect(Markdown.NoteType)(value).pipe(
    Effect.mapError(() =>
      new ApiError({
        status: 400,
        code: "invalid-type",
        message: `Unknown note type: ${typeof value === "string" ? value : ""}`,
      }),
    ),
  )

const isNoteType = (value: string): value is Markdown.NoteType =>
  (Markdown.NOTE_TYPES as ReadonlyArray<string>).includes(value)

const parseNoteId = (
  value: string | undefined,
): Effect.Effect<string, ApiError> => {
  if (value === undefined || !Markdown.isNoteId(value)) {
    return fail(
      400,
      "invalid-id",
      value === undefined
        ? "Missing note id."
        : `Invalid note id: ${value}. Note ids are the Markdown filename stem.`,
    )
  }
  return Effect.succeed(value)
}

const requireString = (
  body: Readonly<Record<string, unknown>>,
  field: string,
): Effect.Effect<string, ApiError> => {
  const value = body[field]
  return typeof value === "string"
    ? Effect.succeed(value)
    : fail(400, "invalid-body", `${field} must be a string.`)
}

const optionalString = (
  body: Readonly<Record<string, unknown>>,
  field: string,
): Effect.Effect<string | undefined, ApiError> => {
  const value = body[field]
  if (value === undefined || value === null) {
    return Effect.succeed(undefined)
  }
  return typeof value === "string"
    ? Effect.succeed(value)
    : fail(400, "invalid-body", `${field} must be a string.`)
}

const optionalStringArray = (
  body: Readonly<Record<string, unknown>>,
  field: string,
): Effect.Effect<ReadonlyArray<string> | undefined, ApiError> => {
  const value = body[field]
  if (value === undefined) {
    return Effect.succeed(undefined)
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return fail(400, "invalid-body", `${field} must be an array of strings.`)
  }
  return Effect.succeed(value as ReadonlyArray<string>)
}

const isJsonContentType = (contentType: string | undefined): boolean =>
  contentType?.toLowerCase().startsWith("application/json") === true

const MAX_JSON_BODY_BYTES = Markdown.MAX_NOTE_FILE_BYTES + 64 * 1024

/**
 * Mutations are same-origin only. A missing Origin header is allowed for
 * command-line clients such as curl; a present Origin must exactly match the
 * request URL. No CORS headers are ever emitted, so a browser preflight cannot
 * authorize a cross-origin write.
 */
const assertSameOrigin = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void, ApiError> => {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return fail(
      403,
      "cross-origin",
      "Cross-origin writes are not allowed.",
    )
  }

  const origin = request.headers["origin"]
  if (origin === undefined) {
    return Effect.void
  }
  if (origin === "null") {
    return fail(403, "cross-origin", "Cross-origin writes are not allowed.")
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return fail(403, "cross-origin", "Invalid Origin header.")
  }

  if (parsed.origin !== requestUrl(request).origin) {
    // Effect's request URL can be path-only in an embedded fetch handler, so
    // compare against the Host header as well when it is present.
    const host = request.headers["host"]
    const sameHost =
      host !== undefined &&
      parsed.host.toLowerCase() === host.toLowerCase() &&
      (parsed.protocol === "http:" || parsed.protocol === "https:")
    if (!sameHost) {
      return fail(
        403,
        "cross-origin",
        "Cross-origin writes are not allowed.",
      )
    }
  }

  return Effect.void
}

const readJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Readonly<Record<string, unknown>>, ApiError> =>
  Effect.gen(function* () {
    yield* assertSameOrigin(request)

    if (!isJsonContentType(request.headers["content-type"])) {
      return yield* fail(
        415,
        "invalid-content-type",
        "Mutating requests require an application/json body.",
      )
    }

    const declaredLength = Number(request.headers["content-length"] ?? "0")
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      return yield* fail(413, "body-too-large", "Request body is too large.")
    }

    const body = yield* request.json.pipe(
      Effect.mapError(() =>
        new ApiError({
          status: 400,
          code: "invalid-body",
          message: "Invalid JSON body.",
        }),
      ),
    )

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return yield* fail(400, "invalid-body", "Expected a JSON object.")
    }

    return body as Readonly<Record<string, unknown>>
  })

const defaultActor = (): string | undefined => {
  const actor = process.env.SLIPMEM_ACTOR?.trim()
  return actor === undefined || actor.length === 0 ? undefined : actor
}

const webProvenance = (): Markdown.Provenance => ({
  source: "web",
  ...(defaultActor() === undefined ? {} : { actor: defaultActor() }),
})

interface CreateBody {
  readonly type: Markdown.NoteType
  readonly title: string
  readonly content: string
  readonly reference: string | undefined
  readonly topics: ReadonlyArray<string> | undefined
}

const readCreateBody = (
  body: Readonly<Record<string, unknown>>,
  forcedType?: Markdown.NoteType,
): Effect.Effect<CreateBody, ApiError> =>
  Effect.gen(function* () {
    const type =
      forcedType === undefined
        ? yield* parseType(body.type)
        : forcedType
    const title = yield* requireString(body, "title")
    const content = yield* requireString(body, "content")
    if (body.type !== undefined && type !== body.type) {
      return yield* fail(
        400,
        "invalid-type",
        `The body type must match the route type (${forcedType}).`,
      )
    }
    const reference = yield* optionalString(body, "reference")
    const topics = yield* optionalStringArray(body, "topics")

    return { type, title, content, reference, topics }
  })

interface UpdateBody {
  readonly type: Markdown.NoteType | undefined
  readonly title: string | undefined
  readonly content: string | undefined
  readonly reference: string | null | undefined
  readonly topics: ReadonlyArray<string> | undefined
}

const readUpdateBody = (
  body: Readonly<Record<string, unknown>>,
): Effect.Effect<UpdateBody, ApiError> =>
  Effect.gen(function* () {
    const type =
      body.type === undefined ? undefined : yield* parseType(body.type)
    const title =
      body.title === undefined ? undefined : yield* requireString(body, "title")
    const content =
      body.content === undefined
        ? undefined
        : yield* requireString(body, "content")
    const reference =
      body.reference === null
        ? null
        : yield* optionalString(body, "reference")
    const topics = yield* optionalStringArray(body, "topics")

    return { type, title, content, reference, topics }
  })

const noteNotFound = (id: string): ApiError =>
  new ApiError({
    status: 404,
    code: "not-found",
    message: `Note not found: ${id}`,
  })

const getNoteOfType = (
  repository: MarkdownNoteRepositoryShape,
  id: string,
  type: Markdown.NoteType,
): Effect.Effect<ParsedMarkdownNote, ApiError | MarkdownError> =>
  repository.get(id).pipe(
    Effect.flatMap((maybeNote) =>
      Option.match(maybeNote, {
        onNone: () => Effect.fail(noteNotFound(id)),
        onSome: (note) =>
          note.metadata.type === type
            ? Effect.succeed(note)
            : Effect.fail(noteNotFound(id)),
      }),
    ),
  )

const getNote = (
  repository: MarkdownNoteRepositoryShape,
  id: string,
): Effect.Effect<ParsedMarkdownNote, ApiError | MarkdownError> =>
  repository.get(id).pipe(
    Effect.flatMap((maybeNote) =>
      Option.match(maybeNote, {
        onNone: () => Effect.fail(noteNotFound(id)),
        onSome: Effect.succeed,
      }),
    ),
  )

const listNotes = (
  repository: MarkdownNoteRepositoryShape,
  filters: {
    readonly type?: Markdown.NoteType
    readonly topic?: string
    readonly limit?: number
  },
) =>
  repository.listNotes(filters).pipe(
    Effect.map((notes) => notes.map(toApiNote)),
  )

/**
 * Canonical ID-based JSON API and the type-route compatibility adapters.
 *
 * List and detail reads always scan the Markdown repository, so a note changed
 * by the CLI, an external editor, or MCP is visible on the next request.
 * Search and topics refresh the disposable index before reading it.
 */
export const MarkdownApiRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const repository = yield* MarkdownNoteRepository
    const index = yield* MarkdownSearchIndex
    const approval = yield* ApprovalService
    const wiki = yield* WikiService

    const health = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const url = requestUrl(request)
          void url
          // Refresh first so a note written by the CLI or an editor is counted.
          // The index is disposable; the note files remain the source of truth.
          yield* index.refresh()
          const status = yield* index.status()
          const synthesis = yield* synthesisCapability(process.env)
          return json({
            ok: true,
            service: "slipmem",
            noteRoot: repository.root,
            index: {
              mode: status.mode,
              path: status.path,
              noteCount: status.noteCount,
            },
            wiki: { synthesis },
          })
        }),
      )

    const list = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const url = requestUrl(request)
          const typeValue = queryValue(url, "type")
          const type =
            typeValue === undefined
              ? undefined
              : yield* parseType(typeValue)
          const topic = queryValue(url, "topic")
          const limit = yield* parseLimit(url)
          const notes = yield* listNotes(repository, { type, topic, limit })
          return json({ notes })
        }),
      )

    const get = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          void request
          const params = yield* HttpRouter.params
          const segment = params.id
          if (segment !== undefined && isNoteType(segment)) {
            const notes = yield* listNotes(repository, {
              type: segment,
              limit: DEFAULT_LIST_LIMIT,
            })
            return json({ notes })
          }
          const id = yield* parseNoteId(segment)
          const note = yield* getNote(repository, id)
          return json({ note: toApiNote(note) })
        }),
      )

    const getByType = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          void request
          const params = yield* HttpRouter.params
          const type = yield* parseType(params.type)
          const id = yield* parseNoteId(params.id)
          const note = yield* getNoteOfType(repository, id, type)
          return json({ note: toApiNote(note) })
        }),
      )

    const create = (
      request: HttpServerRequest.HttpServerRequest,
      forcedType?: Markdown.NoteType,
    ) =>
      route(
        Effect.gen(function* () {
          const body = yield* readJsonBody(request)
          const input = yield* readCreateBody(body, forcedType)
          const note = yield* repository.create({
            type: input.type,
            title: input.title,
            content: input.content,
            ...(input.reference === undefined ? {} : { reference: input.reference }),
            ...(input.topics === undefined ? {} : { topics: input.topics }),
            provenance: webProvenance(),
          })
          return json({ note: toApiNote(note) }, 201)
        }),
      )

    const createByType = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const type = yield* parseType(params.type)
          return yield* create(request, type)
        }),
      )

    const update = (
      request: HttpServerRequest.HttpServerRequest,
      id: string,
      type?: Markdown.NoteType,
    ) =>
      route(
        Effect.gen(function* () {
          if (type !== undefined) {
            // Compatibility routes must not mutate a note through the wrong
            // type name.
            yield* getNoteOfType(repository, id, type)
          }
          const body = yield* readJsonBody(request)
          const input = yield* readUpdateBody(body)
          const note = yield* repository.update({
            id,
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.reference === undefined
              ? {}
              : { reference: input.reference }),
            ...(input.topics === undefined ? {} : { topics: input.topics }),
            provenance: webProvenance(),
          })
          return json({ note: toApiNote(note) })
        }),
      )

    const updateCanonical = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const id = yield* parseNoteId(params.id)
          return yield* update(request, id)
        }),
      )

    const updateByType = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const type = yield* parseType(params.type)
          const id = yield* parseNoteId(params.id)
          return yield* update(request, id, type)
        }),
      )

    const remove = (
      request: HttpServerRequest.HttpServerRequest,
      id: string,
      type?: Markdown.NoteType,
    ) =>
      route(
        Effect.gen(function* () {
          yield* assertSameOrigin(request)
          if (type !== undefined) {
            yield* getNoteOfType(repository, id, type)
          } else {
            yield* getNote(repository, id)
          }
          const deleted = yield* repository.delete(id)
          const status = yield* index.refresh()
          return json({
            deleted: true,
            id: deleted.id,
            backupPath: deleted.backupPath,
            index: status,
          })
        }),
      )

    const removeCanonical = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const id = yield* parseNoteId(params.id)
          return yield* remove(request, id)
        }),
      )

    const removeByType = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const type = yield* parseType(params.type)
          const id = yield* parseNoteId(params.id)
          return yield* remove(request, id, type)
        }),
      )

    const search = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const url = requestUrl(request)
          const query = queryValue(url, "q")
          if (query === undefined) {
            return yield* fail(400, "missing-query", "Search requires a non-empty q parameter.")
          }
          if (query.length > MAX_SEARCH_QUERY_LENGTH) {
            return yield* fail(
              400,
              "query-too-long",
              `Search queries must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer.`,
            )
          }
          const typeValue = queryValue(url, "type")
          const type =
            typeValue === undefined ? undefined : yield* parseType(typeValue)
          const topic = queryValue(url, "topic")
          const limit = yield* parseLimit(url)
          yield* index.refresh()
          const hits = yield* index.search({
            query,
            ...(type === undefined ? {} : { kinds: [type] }),
            ...(topic === undefined ? {} : { topic }),
            ...(limit === undefined ? {} : { limit }),
          })
          return json({
            query,
            results: hits.map((hit) => ({
              note: hit.note,
              id: hit.id,
              path: hit.path,
              score: hit.score,
            })),
          })
        }),
      )

    const topics = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const url = requestUrl(request)
          const query = queryValue(url, "q")
          const limit = yield* parseLimit(url)
          yield* index.refresh()
          const items = yield* index.listTopics({
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
          })
          // Topic counts include every note type. The wiki cites permanent and
          // literature notes by default, so expose a per-type breakdown too;
          // otherwise a fleeting-only topic looks empty on its topic page.
          const scan = yield* repository.scan()
          const counts = new Map<
            string,
            { fleeting: number; literature: number; permanent: number }
          >()
          for (const note of scan.notes) {
            for (const topic of note.metadata.topics ?? []) {
              const current = counts.get(topic) ?? {
                fleeting: 0,
                literature: 0,
                permanent: 0,
              }
              current[note.metadata.type] += 1
              counts.set(topic, current)
            }
          }
          return json({
            topics: items.map((item) => ({
              ...item,
              byType: counts.get(item.topic) ?? {
                fleeting: 0,
                literature: 0,
                permanent: 0,
              },
            })),
          })
        }),
      )

    const wikiPage = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          const params = yield* HttpRouter.params
          const url = requestUrl(request)
          const rawTopic = params.topic
          if (rawTopic === undefined || Markdown.slugifyTopic(rawTopic) === "") {
            return yield* fail(
              400,
              "invalid-topic",
              "A topic must normalize to a lowercase kebab-case slug.",
            )
          }

          const rawMode = queryValue(url, "mode")
          const mode =
            rawMode === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(Markdown.WikiMode)(
                  rawMode,
                ).pipe(
                  Effect.mapError(
                    () =>
                      new ApiError({
                        status: 400,
                        code: "invalid-mode",
                        message: "mode must be extractive or synthesized.",
                      }),
                  ),
                )
          const limit = yield* parseLimit(url)
          const includeFleeting = url.searchParams.get("includeFleeting") === "true"

          const page = yield* wiki.build({
            topic: rawTopic,
            ...(limit === undefined ? {} : { limit }),
            ...(mode === undefined ? {} : { mode }),
            ...(includeFleeting ? { includeFleeting } : {}),
          })
          const synthesis = yield* synthesisCapability(process.env)

          if (url.searchParams.get("format") === "markdown") {
            return HttpServerResponse.text(page.markdown, {
              contentType: "text/markdown; charset=utf-8",
              headers: {
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              },
            })
          }

          return json({ ...page, synthesis })
        }),
      )

    const pending = () =>
      route(
        Effect.gen(function* () {
          const report = yield* approval.review()
          return json({
            proposals: report.proposals.map((item) => ({
              id: item.proposal.id,
              operation: item.proposal.operation,
              noteId: item.proposal.noteId,
              path: item.proposal.path,
              summary: item.summary,
              createdAt: item.proposal.createdAt,
              expiresAt: item.proposal.expiresAt,
              ...(item.proposal.actor === undefined
                ? {}
                : { actor: item.proposal.actor }),
              stale: item.stale,
              expired: item.expired,
              diff: item.diff,
              ...(item.proposal.operation === "delete"
                ? {}
                : { content: item.proposal.content }),
            })),
            invalid: report.invalid.map((error) => ({
              code: error.code,
              message: error.message,
            })),
            removed: report.removed,
          })
        }),
      )

    const approve = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          yield* assertSameOrigin(request)
          const params = yield* HttpRouter.params
          const proposalId = params.proposalId
          if (proposalId === undefined || proposalId.length === 0) {
            return yield* fail(400, "invalid-proposal", "Missing proposal id.")
          }
          const applied = yield* approval.apply(proposalId)
          return json(
            applied.operation === "delete"
              ? {
                  status: applied.status,
                  proposalId: applied.proposalId,
                  operation: applied.operation,
                  noteId: applied.noteId,
                  backupPath: applied.backupPath,
                  index: applied.index,
                }
              : {
                  status: applied.status,
                  proposalId: applied.proposalId,
                  operation: applied.operation,
                  noteId: applied.noteId,
                  note: toApiNote(applied.note),
                  index: applied.index,
                },
          )
        }),
      )

    const reject = (request: HttpServerRequest.HttpServerRequest) =>
      route(
        Effect.gen(function* () {
          yield* assertSameOrigin(request)
          const params = yield* HttpRouter.params
          const proposalId = params.proposalId
          if (proposalId === undefined || proposalId.length === 0) {
            return yield* fail(400, "invalid-proposal", "Missing proposal id.")
          }
          const rejected = yield* approval.reject(proposalId)
          return json(rejected)
        }),
      )

    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/health", health),
      HttpRouter.add("GET", "/api/notes", list),
      HttpRouter.add("POST", "/api/notes", create),
      HttpRouter.add("GET", "/api/notes/:id", get),
      HttpRouter.add("PUT", "/api/notes/:id", updateCanonical),
      HttpRouter.add("DELETE", "/api/notes/:id", removeCanonical),
      // Compatibility adapters for the pre-cutover type routes. They resolve
      // through the same ID-based repository and never create type folders.
      HttpRouter.add("GET", "/api/notes/:type/:id", getByType),
      HttpRouter.add("POST", "/api/notes/:type", createByType),
      HttpRouter.add("PUT", "/api/notes/:type/:id", updateByType),
      HttpRouter.add("DELETE", "/api/notes/:type/:id", removeByType),
      HttpRouter.add("GET", "/api/search", search),
      HttpRouter.add("GET", "/api/topics", topics),
      HttpRouter.add("GET", "/api/wiki/:topic", wikiPage),
      HttpRouter.add("GET", "/api/pending", pending),
      HttpRouter.add("POST", "/api/pending/:proposalId/approve", approve),
      HttpRouter.add("POST", "/api/pending/:proposalId/reject", reject),
    )
  }),
)
