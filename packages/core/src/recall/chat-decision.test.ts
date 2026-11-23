import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import {
  makeChatPromptRecallEvaluator,
  MAX_CHAT_RECALL_OUTPUT_CHARS,
} from "./chat-decision.js"
import type { PromptRecallEvaluation } from "./evaluator.js"
import { recallEvaluatorError } from "./errors.js"
import {
  modelTransportError,
  type ModelChatRequest,
  type ModelTransport,
} from "../model/openai-compatible-transport.js"

const evaluation: PromptRecallEvaluation = {
  prompt: "Deploy the release",
  note: {
    id: "deploy-release",
    title: "Release checklist",
    content: "Run the release script and verify the deploy.",
    tags: ["release"],
    updatedAt: 1_700_000_000_000,
  },
}

type TestChat = (
  request: ModelChatRequest,
) => Effect.Effect<{ content: string }, unknown>

const fakeTransport = (chat: TestChat): ModelTransport => ({
  chat: chat as ModelTransport["chat"],
})

const errorOf = async (
  effect: Effect.Effect<unknown, { readonly code: string }>,
) => {
  const exit = await Effect.runPromiseExit(effect)
  if (exit._tag === "Success") {
    throw new Error("Expected the evaluator to fail")
  }
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure === undefined || failure._tag !== "Fail") {
    throw new Error("Expected a typed evaluator failure")
  }
  return failure.error
}

const makeEvaluator = (
  chat: TestChat,
) => makeChatPromptRecallEvaluator({ transport: fakeTransport(chat), model: "chat-model" })

describe("structured chat prompt-recall evaluator", () => {
  test("sends one tool-less bounded decision request and validates JSON", async () => {
    const seen = await Effect.runPromise(Ref.make<ReadonlyArray<ModelChatRequest>>([]))
    const evaluator = makeEvaluator((request) =>
      Ref.update(seen, (requests) => [...requests, request]).pipe(
        Effect.as({ content: '{"verdict":"relevant","confidence":0.8}' }),
      ),
    )

    const decision = await Effect.runPromise(evaluator.evaluate(evaluation))
    expect(decision).toEqual({ verdict: "relevant", confidence: 0.8 })
    expect(evaluator.model).toBe("chat-model")

    const requests = await Effect.runPromise(Ref.get(seen))
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.temperature).toBe(0)
    expect(request.maxTokens).toBeGreaterThan(0)
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0]!.role).toBe("system")
    expect(request.messages[1]!.role).toBe("user")
    expect(request.messages[0]!.content).toContain("untrusted repository data")
    const payload = JSON.parse(request.messages[1]!.content) as Record<string, unknown>
    expect(payload.query).toBe("Deploy the release")
    expect(payload.note).toMatchObject({ id: "deploy-release" })
    expect(request).not.toHaveProperty("tools")
  })

  test("rejects prose, wrong verdicts, out-of-range confidence, and oversized output", async () => {
    const prose = makeEvaluator(() => Effect.succeed({ content: "relevant" }))
    expect((await errorOf(prose.evaluate(evaluation))).code).toBe("invalid-output")

    const wrongVerdict = makeEvaluator(() =>
      Effect.succeed({ content: '{"verdict":"maybe"}' }),
    )
    expect((await errorOf(wrongVerdict.evaluate(evaluation))).code).toBe(
      "invalid-output",
    )

    const outOfRange = makeEvaluator(() =>
      Effect.succeed({ content: '{"verdict":"relevant","confidence":2}' }),
    )
    expect((await errorOf(outOfRange.evaluate(evaluation))).code).toBe(
      "invalid-output",
    )

    const oversized = makeEvaluator(() =>
      Effect.succeed({
        content: `{"verdict":"relevant","padding":"${"x".repeat(
          MAX_CHAT_RECALL_OUTPUT_CHARS,
        )}"}`,
      }),
    )
    expect((await errorOf(oversized.evaluate(evaluation))).code).toBe(
      "invalid-output",
    )
  })

  test("surfaces a configured provider failure without retrying or falling back", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const evaluator = makeEvaluator(() =>
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(
          Effect.fail(
            modelTransportError({
              code: "network",
              message: "offline",
            }),
          ),
        ),
      ),
    )

    const failure = await errorOf(evaluator.evaluate(evaluation))
    expect(failure.code).toBe("transport")
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1)
  })

  test("maps an injected non-transport failure to a typed transport failure", async () => {
    const evaluator = makeEvaluator(() =>
      Effect.fail(
        recallEvaluatorError({
          code: "unavailable",
          message: "upstream unavailable",
        }),
      ),
    )
    const failure = await errorOf(evaluator.evaluate(evaluation))
    expect(failure.code).toBe("transport")
  })
})
