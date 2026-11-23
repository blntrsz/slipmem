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
