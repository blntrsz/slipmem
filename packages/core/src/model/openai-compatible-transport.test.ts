import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  makeOpenAiCompatibleTransport,
  type ModelFetch,
  type ModelTransportError,
} from "./openai-compatible-transport.js"

const servers: Array<ReturnType<typeof Bun.serve>> = []

const serve = (
  fetch: (request: Request) => Response | Promise<Response>,
): { readonly baseUrl: string; readonly server: ReturnType<typeof Bun.serve> } => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch,
  })
  servers.push(server)
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, server }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true)
  }
})

const failure = async (
  effect: Effect.Effect<unknown, ModelTransportError>,
): Promise<ModelTransportError> => {
  const exit = await Effect.runPromiseExit(effect)
  return failureFromExit(exit)
}

const failureFromExit = (
  exit: Exit.Exit<unknown, ModelTransportError>,
): ModelTransportError => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected the model transport to fail")
  }
  const fail = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (fail === undefined || fail._tag !== "Fail") {
    throw new Error("Expected a typed model transport failure")
  }
  return fail.error
}

const messages = [{ role: "user" as const, content: "Return JSON." }]

describe("OpenAI-compatible model transport", () => {
  test("posts explicit chat messages without tools and returns content unparsed", async () => {
    let received: Record<string, unknown> | undefined
    let path = ""
    let authorization = ""

    const { baseUrl } = serve(async (request) => {
      path = new URL(request.url).pathname
      authorization = request.headers.get("authorization") ?? ""
      received = (await request.json()) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { role: "assistant", content: "not JSON" } }],
      })
    })

    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
      apiKey: "test-key",
    })

    const result = await Effect.runPromise(
      transport.chat({
        messages,
        temperature: 0.2,
        maxTokens: 128,
      }),
    )

    expect(result.content).toBe("not JSON")
    expect(path).toBe("/v1/chat/completions")
    expect(authorization).toBe("Bearer test-key")
    expect(received).toMatchObject({
      model: "explicit-model",
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 128,
    })
    expect(received).not.toHaveProperty("tools")
    expect(received).not.toHaveProperty("tool_choice")
  })

  test("accepts explicit HTTPS and rejects plain HTTP outside loopback", async () => {
    let requested: string | undefined
    const fakeFetch: ModelFetch = async (input) => {
      requested = String(input)
      return Response.json({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      })
    }

    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: fakeFetch,
    })
    const result = await Effect.runPromise(transport.chat({ messages }))
    expect(result.content).toBe("{\"ok\":true}")
    expect(requested).toBe("https://provider.example/v1/chat/completions")

    let fetched = false
    const insecureFetch: ModelFetch = async () => {
      fetched = true
      return Response.json({})
    }
    const insecure = makeOpenAiCompatibleTransport({
      baseUrl: "http://provider.example/v1",
      model: "explicit-model",
      fetch: insecureFetch,
    })
    const error = await failure(insecure.chat({ messages }))
    expect(error.code).toBe("invalid-config")
    expect(fetched).toBe(false)
  })

  test("requires an explicit provider URL with no default", async () => {
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: " ",
      model: "explicit-model",
      fetch: async () => Response.json({}),
    })
    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("invalid-config")
    expect(error.message).toContain("no default provider URL")
  })

  test("exposes only the HTTP status and never the response body or key", async () => {
    const { baseUrl } = serve(
      () =>
        new Response("provider-secret-body", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    )
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
      apiKey: "test-secret-key",
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("http-status")
    expect(error.status).toBe(503)
    expect(error.message).toBe("Model provider returned HTTP 503.")
    expect(JSON.stringify(error)).not.toContain("provider-secret-body")
    expect(JSON.stringify(error)).not.toContain("test-secret-key")
  })

  test("does not follow redirects", async () => {
    let followed = 0
    const { baseUrl } = serve((request) => {
      if (new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response(null, {
          status: 307,
          headers: { location: "/followed" },
        })
      }
      followed++
      return Response.json({ choices: [{ message: { content: "followed" } }] })
    })
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("http-status")
    expect(error.status).toBe(307)
    expect(followed).toBe(0)
  })

  test("times out a slow provider", async () => {
    const { baseUrl } = serve(() => new Promise<Response>(() => undefined))
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
      timeoutMs: 25,
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("timeout")
  })

  test("aborts an in-flight request through the caller signal", async () => {
    const { baseUrl } = serve(() => new Promise<Response>(() => undefined))
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
    })
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(
      transport.chat({ messages, signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 20)

    const error = failureFromExit(await pending)
    expect(error.code).toBe("aborted")
  })

  test("bounds the response bytes even without a content-length header", async () => {
    const { baseUrl } = serve(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"choices":[{"message":{"content":"',
                ),
              )
              controller.enqueue(new TextEncoder().encode("x".repeat(128)))
              controller.enqueue(new TextEncoder().encode('"}}]}'))
              controller.close()
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
      maxResponseBytes: 64,
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("response-too-large")
  })

  test("rejects a 2xx response without a first assistant message", async () => {
    const { baseUrl } = serve(() => Response.json({ choices: [] }))
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("response-invalid")
  })

  test("stays inert on construction and never calls the provider without an explicit request", async () => {
    let fetched = 0
    const spy: ModelFetch = async () => {
      fetched++
      return Response.json({})
    }

    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: spy,
    })
    expect(fetched).toBe(0)
    expect(typeof transport.chat).toBe("function")

    const invalid = makeOpenAiCompatibleTransport({
      baseUrl: "not an absolute URL",
      model: "explicit-model",
      fetch: spy,
    })
    expect(fetched).toBe(0)
    const error = await failure(invalid.chat({ messages }))
    expect(error.code).toBe("invalid-config")
    expect(fetched).toBe(0)
  })

  test("does not call the provider when the caller signal is already aborted", async () => {
    let fetched = 0
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: async () => {
        fetched++
        return Response.json({})
      },
    })
    const controller = new AbortController()
    controller.abort()

    const error = await failure(
      transport.chat({ messages, signal: controller.signal }),
    )
    expect(error.code).toBe("aborted")
    expect(fetched).toBe(0)
  })

  test("rejects a tool-call completion even when it also has string content", async () => {
    const { baseUrl } = serve(() =>
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "provider-secret-tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    )
    const transport = makeOpenAiCompatibleTransport({
      baseUrl,
      model: "explicit-model",
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("response-invalid")
    expect(error.message).toContain("tool calls")
    expect(JSON.stringify(error)).not.toContain("provider-secret-tool")
  })

  test("rejects a legacy function-call completion", async () => {
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: async () =>
        Response.json({
          choices: [
            {
              finish_reason: "function_call",
              message: {
                content: "prefix",
                function_call: { name: "provider-secret-tool", arguments: "{}" },
              },
            },
          ],
        }),
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("response-invalid")
    expect(error.message).toContain("tool calls")
  })

  test("accepts an empty tool_calls array when no call was made", async () => {
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: async () =>
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "plain", tool_calls: [] },
            },
          ],
        }),
    })

    const result = await Effect.runPromise(transport.chat({ messages }))
    expect(result.content).toBe("plain")
  })

  test("bounds a response by its declared content-length before reading it", async () => {
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      maxResponseBytes: 64,
      fetch: async () =>
        new Response("{}", { headers: { "content-length": "4096" } }),
    })

    const error = await failure(transport.chat({ messages }))
    expect(error.code).toBe("response-too-large")
  })

  test("aborts a body read after the response headers arrive", async () => {
    const encoder = new TextEncoder()
    const transport = makeOpenAiCompatibleTransport({
      baseUrl: "https://provider.example/v1",
      model: "explicit-model",
      fetch: async (_input, init) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('{"choices":[{"message":{"content":"'),
              )
              signal?.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              )
            },
            pull() {
              return new Promise(() => undefined)
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(
      transport.chat({ messages, signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 10)

    const error = failureFromExit(await pending)
    expect(error.code).toBe("aborted")
  })
})
