import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

import {
  ApiError,
  approveProposal,
  deleteNote,
  rejectProposal,
  updateNote,
} from "./api"

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >,
): HttpClient.HttpClient =>
  HttpClient.makeWith(
    Effect.fnUntraced(function* (requestEffect) {
      const request = yield* requestEffect
      return yield* handler(request)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<
      HttpClientError.HttpClientError,
      never
    >,
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.provideService(effect, HttpClient.HttpClient, makeHttpClient(handler)),
  )

const failureOf = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >,
): Promise<E> =>
  Effect.runPromise(
    Effect.flip(
      Effect.provideService(
        effect,
        HttpClient.HttpClient,
        makeHttpClient(handler),
      ),
    ),
  )

const noteId = "20261117201500-bounded-recall"
const proposalId = "proposal-20261117210000-deadbeef"

test("delete requires a true, matching success body", async () => {
  await expect(
    run(deleteNote(noteId), (request) =>
      Effect.succeed(jsonResponse(request, { deleted: true, id: noteId })),
    ),
  ).resolves.toBe(true)

  const malformed = await failureOf(deleteNote(noteId), (request) =>
    Effect.succeed(jsonResponse(request, { deleted: false, id: noteId })),
  )
  expect(malformed).toBeInstanceOf(ApiError)
  expect((malformed as ApiError).message).toBe(
    "The server returned an unexpected response.",
  )

  const mismatch = await failureOf(deleteNote(noteId), (request) =>
    Effect.succeed(jsonResponse(request, { deleted: true, id: "another" })),
  )
  expect(mismatch).toBeInstanceOf(ApiError)
})

test("conditional mutations send the loaded hash as If-Match", async () => {
  const note = {
    type: "permanent",
    id: noteId,
    title: "Bounded recall",
    content: "Every recall operation has a hard maximum.",
    tags: [],
    path: `/notes/${noteId}.md`,
    contentHash: "b".repeat(64),
    createdAt: 1,
    updatedAt: 2,
  }
  const seen: Array<string | undefined> = []

  await expect(
    run(
      updateNote(noteId, { title: "Changed", content: "Body", tags: [] }, "a".repeat(64)),
      (request) => {
        seen.push(request.headers["if-match"])
        return Effect.succeed(jsonResponse(request, { note }))
      },
    ),
  ).resolves.toMatchObject({ id: noteId })

  await expect(
    run(deleteNote(noteId, "a".repeat(64)), (request) => {
      seen.push(request.headers["if-match"])
      return Effect.succeed(jsonResponse(request, { deleted: true, id: noteId }))
    }),
  ).resolves.toBe(true)

  expect(seen).toEqual([`"${"a".repeat(64)}"`, `"${"a".repeat(64)}"`])

  await run(
    updateNote(noteId, { title: "Changed", content: "Body", tags: [] }),
    (request) => {
      seen.push(request.headers["if-match"])
      return Effect.succeed(jsonResponse(request, { note }))
    },
  )
  expect(seen.at(-1)).toBeUndefined()
})

test("a stale conditional mutation surfaces the server conflict", async () => {
  const conflict = await failureOf(
    updateNote(noteId, { title: "Changed", content: "Body", tags: [] }, "stale"),
    (request) =>
      Effect.succeed(
        jsonResponse(
          request,
          {
            error:
              "The note changed after this operation was prepared, so its base content hash no longer matches.",
            code: "stale-base",
          },
          409,
        ),
      ),
  )
  expect(conflict).toBeInstanceOf(ApiError)
  expect(conflict).toMatchObject({ status: 409 })
  expect((conflict as ApiError).message).toContain("base content hash")
})

test("approve and reject validate their success bodies and proposal id", async () => {
  await expect(
    run(approveProposal(proposalId), (request) =>
      Effect.succeed(
        jsonResponse(request, {
          status: "applied",
          proposalId,
          noteId,
        }),
      ),
    ),
  ).resolves.toEqual({ status: "applied", proposalId, noteId })

  const malformedApprove = await failureOf(
    approveProposal(proposalId),
    (request) =>
      Effect.succeed(
        jsonResponse(request, { status: "pending", proposalId, noteId }),
      ),
  )
  expect(malformedApprove).toBeInstanceOf(ApiError)

  const mismatchedApprove = await failureOf(
    approveProposal(proposalId),
    (request) =>
      Effect.succeed(
        jsonResponse(request, {
          status: "applied",
          proposalId: "another",
          noteId,
        }),
      ),
  )
  expect(mismatchedApprove).toBeInstanceOf(ApiError)

  await expect(
    run(rejectProposal(proposalId), (request) =>
      Effect.succeed(
        jsonResponse(request, { status: "rejected", proposalId }),
      ),
    ),
  ).resolves.toEqual({ status: "rejected", proposalId })

  const mismatchReject = await failureOf(
    rejectProposal(proposalId),
    (request) =>
      Effect.succeed(
        jsonResponse(request, { status: "rejected", proposalId: "another" }),
      ),
  )
  expect(mismatchReject).toBeInstanceOf(ApiError)
})
