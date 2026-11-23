import { Data, Effect, Predicate } from "effect"

/**
 * One explicit OpenAI-compatible `/chat/completions` transport.
 *
 * This module deliberately ships no provider URL, model catalog, agent runtime,
 * or tool support. A caller must supply an explicit base URL and model, and the
 * request body contains only chat messages plus optional sampling bounds. The
 * response is consumed as the assistant's `content` string; callers that expect
 * JSON parse that string themselves.
 *
 * Nothing here logs a request payload, response body, authorization value, or
 * URL. HTTP failures expose only the status code. Redirects are not followed,
 * HTTPS is required except for loopback HTTP, and both time and response bytes
 * are bounded.
 */

export const DEFAULT_MODEL_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 1024 * 1024
export const MAX_MODEL_TIMEOUT_MS = 10 * 60_000
export const MAX_MODEL_RESPONSE_BYTES = 16 * 1024 * 1024

export type ModelTransportErrorCode =
  | "invalid-config"
  | "invalid-request"
  | "aborted"
  | "timeout"
  | "network"
  | "http-status"
  | "response-too-large"
  | "response-invalid"

export interface ModelTransportErrorFields {
  readonly code: ModelTransportErrorCode
  readonly message: string
  /** Present only for `http-status`; never includes the response body. */
  readonly status?: number
}

/** A typed model transport failure with no payload or credential content. */
export class ModelTransportError extends Data.TaggedError("ModelTransportError")<ModelTransportErrorFields> {}

export const modelTransportError = (
  fields: ModelTransportErrorFields,
): ModelTransportError => new ModelTransportError(fields)

export interface OpenAiCompatibleProviderConfig {
  /**
   * Explicit provider base URL such as `https://provider.example/v1`.
   *
   * There is no default. `/chat/completions` is appended unless the path
   * already ends with it. HTTPS is accepted for any host; plain HTTP is
   * accepted only for loopback hosts.
   */
  readonly baseUrl: string
  /** Explicit model identifier sent to the provider. */
  readonly model: string
  /** Optional bearer token. It is never logged or included in errors. */
  readonly apiKey?: string
  /** Per-call timeout; defaults to 30 seconds. */
  readonly timeoutMs?: number
  /** Per-call response byte bound; defaults to 1 MiB. */
  readonly maxResponseBytes?: number
  /** Extra provider headers, such as an API-version header. */
  readonly headers?: Readonly<Record<string, string>>
  /** Test seam; production always uses the Node/Bun global fetch. */
  readonly fetch?: ModelFetch
}

export type ModelChatRole = "system" | "user" | "assistant"

export interface ModelChatMessage {
  readonly role: ModelChatRole
  readonly content: string
}

export interface ModelChatRequest {
  readonly messages: ReadonlyArray<ModelChatMessage>
  /** Aborts the fetch and body read. Interrupting the Effect also aborts it. */
  readonly signal?: AbortSignal
  /** Overrides the provider timeout for this call. */
  readonly timeoutMs?: number
  /** Overrides the provider response byte bound for this call. */
  readonly maxResponseBytes?: number
  readonly temperature?: number
  /** Sent as `max_tokens` for broad OpenAI-compatible support. */
  readonly maxTokens?: number
}

export interface ModelChatResult {
  /**
   * The assistant content exactly as returned. JSON-shaped output is not
   * parsed here; the automatic-maintenance and recall callers own that schema.
   */
  readonly content: string
}

export type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * The transport surface shared by automatic maintenance chat and recall. Both
 * callers use `chat` with their own bounded messages and parse the returned
 * content for their own schema.
 */
export interface ModelTransport {
  readonly chat: (
    request: ModelChatRequest,
  ) => Effect.Effect<ModelChatResult, ModelTransportError>
}

const invalidConfig = (message: string): ModelTransportError =>
  modelTransportError({ code: "invalid-config", message })

const invalidRequest = (message: string): ModelTransportError =>
  modelTransportError({ code: "invalid-request", message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value)

const isLoopbackHost = (hostname: string): boolean => {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  if (host === "localhost" || host === "::1") {
    return true
  }
  const octets = host.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/.test(octet) && Number.parseInt(octet, 10) <= 255,
    )
  )
}

const chatEndpoint = (baseUrl: string): URL => {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw invalidConfig(
      "Model provider baseUrl must be an absolute HTTPS URL, or an HTTP loopback URL. No provider URL is assumed.",
    )
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidConfig(
      "Model provider baseUrl must use HTTPS, or HTTP only for a loopback host.",
    )
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw invalidConfig(
      "Plain HTTP model providers are allowed only on a loopback host.",
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidConfig(
      "Model provider baseUrl must not contain credentials; pass credentials as an explicit header or apiKey.",
    )
  }
  if (url.search !== "" || url.hash !== "") {
    throw invalidConfig(
      "Model provider baseUrl must not contain a query string or fragment.",
    )
  }

  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/chat/completions")
    ? path
    : `${path}/chat/completions`
  return url
}

const boundedTimeout = (
  value: number | undefined,
  fallback: number,
  field: string,
  error: (message: string) => ModelTransportError = invalidConfig,
): number => {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_MODEL_TIMEOUT_MS
  ) {
    throw error(
      `${field} must be a positive integer no greater than ${MAX_MODEL_TIMEOUT_MS} milliseconds.`,
    )
  }
  return resolved
}

const boundedResponseBytes = (
  value: number | undefined,
  fallback: number,
  field: string,
  error: (message: string) => ModelTransportError = invalidConfig,
): number => {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_MODEL_RESPONSE_BYTES
  ) {
    throw error(
      `${field} must be a positive integer no greater than ${MAX_MODEL_RESPONSE_BYTES} bytes.`,
    )
  }
  return resolved
}

const validateConfig = (
  config: OpenAiCompatibleProviderConfig,
): {
  readonly endpoint: URL
  readonly timeoutMs: number
  readonly maxResponseBytes: number
} => {
  if (config.baseUrl.trim() === "") {
    throw invalidConfig(
      "Model provider baseUrl is required; this transport has no default provider URL.",
    )
  }
  if (config.model.trim() === "") {
    throw invalidConfig("Model provider model is required.")
  }
  if (config.apiKey !== undefined && config.apiKey.trim() === "") {
    throw invalidConfig("Model provider apiKey must not be blank when supplied.")
  }

  return {
    endpoint: chatEndpoint(config.baseUrl),
    timeoutMs: boundedTimeout(
      config.timeoutMs,
      DEFAULT_MODEL_TIMEOUT_MS,
      "timeoutMs",
    ),
    maxResponseBytes: boundedResponseBytes(
      config.maxResponseBytes,
      DEFAULT_MAX_MODEL_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
  }
}

const requestOptions = (request: ModelChatRequest): {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly temperature?: number
  readonly maxTokens?: number
} => {
  if (request.messages.length === 0) {
    throw invalidRequest("At least one chat message is required.")
  }
  for (const message of request.messages) {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      throw invalidRequest(
        "Chat messages must use the system, user, or assistant role.",
      )
    }
    if (typeof message.content !== "string") {
      throw invalidRequest("Chat message content must be a string.")
    }
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 2)
  ) {
    throw invalidRequest("temperature must be a finite number from 0 to 2.")
  }
  if (
    request.maxTokens !== undefined &&
    (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)
  ) {
    throw invalidRequest("maxTokens must be a positive integer.")
  }
  return {
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
    ...(request.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: request.maxResponseBytes }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxTokens === undefined
      ? {}
      : { maxTokens: request.maxTokens }),
  }
}

const responseTooLarge = (maxBytes: number): ModelTransportError =>
  modelTransportError({
    code: "response-too-large",
    message: `Model provider response exceeded the ${maxBytes} byte bound.`,
  })

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw responseTooLarge(maxBytes)
    }
  }
  if (response.body === null) {
    return ""
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLarge(maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The reader may already be released after cancellation.
    }
  }
}

const hasToolCalls = (
  choice: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean => {
  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) ? toolCalls.length > 0 : toolCalls != null) {
    return true
  }
  if (message.function_call != null) {
    return true
  }
  return (
    choice.finish_reason === "tool_calls" ||
    choice.finish_reason === "function_call"
  )
}

const assistantContent = (raw: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw modelTransportError({
      code: "response-invalid",
      message:
        "Model provider returned HTTP 2xx with a body that is not a chat-completion JSON object.",
    })
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw modelTransportError({
      code: "response-invalid",
      message:
        "Model provider returned HTTP 2xx without a chat-completion choices array.",
    })
  }
  const choice: unknown = parsed.choices[0]
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw modelTransportError({
      code: "response-invalid",
      message:
        "Model provider returned HTTP 2xx without a first assistant message.",
    })
  }
  if (hasToolCalls(choice, choice.message)) {
    throw modelTransportError({
      code: "response-invalid",
      message:
        "Model provider returned tool calls; this transport does not send or accept tools.",
    })
  }
  const content = choice.message.content
  if (typeof content !== "string") {
    throw modelTransportError({
      code: "response-invalid",
      message:
        "Model provider returned HTTP 2xx without string assistant content; tool calls are not supported by this transport.",
    })
  }
  return content
}

const httpStatusError = (status: number): ModelTransportError =>
  modelTransportError({
    code: "http-status",
    status,
    message: `Model provider returned HTTP ${status}.`,
  })

const abortedError = (): ModelTransportError =>
  modelTransportError({
    code: "aborted",
    message: "Model provider request was aborted.",
  })

const timeoutError = (timeoutMs: number): ModelTransportError =>
  modelTransportError({
    code: "timeout",
    message: `Model provider request exceeded the ${timeoutMs} millisecond timeout.`,
  })

const networkError = (): ModelTransportError =>
  modelTransportError({
    code: "network",
    message:
      "Model provider request failed before a complete response was received.",
  })

/**
 * One bounded, Abortable chat completion without tools. Redirects are returned
 * as `http-status` errors and never followed. The caller owns any JSON schema in
 * the returned assistant content.
 */
export const requestModelChat = Effect.fnUntraced(function* (
  config: OpenAiCompatibleProviderConfig,
  request: ModelChatRequest,
): Effect.fn.Return<ModelChatResult, ModelTransportError> {
  const resolved = yield* Effect.try({
    try: () => validateConfig(config),
    catch: (cause) =>
      cause instanceof ModelTransportError
        ? cause
        : invalidConfig("Model provider configuration is invalid."),
  })
  const options = yield* Effect.try({
    try: () => requestOptions(request),
    catch: (cause) =>
      cause instanceof ModelTransportError
        ? cause
        : invalidRequest("Chat request is invalid."),
  })
  const timeoutMs = yield* Effect.try({
    try: () =>
      boundedTimeout(
        options.timeoutMs,
        resolved.timeoutMs,
        "timeoutMs",
        invalidRequest,
      ),
    catch: (cause) =>
      cause instanceof ModelTransportError
        ? cause
        : invalidRequest("Chat request timeout is invalid."),
  })
  const maxResponseBytes = yield* Effect.try({
    try: () =>
      boundedResponseBytes(
        options.maxResponseBytes,
        resolved.maxResponseBytes,
        "maxResponseBytes",
        invalidRequest,
      ),
    catch: (cause) =>
      cause instanceof ModelTransportError
        ? cause
        : invalidRequest("Chat request response bound is invalid."),
  })

  const body = JSON.stringify({
    model: config.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: false,
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
  })

  const headers: Record<string, string> = {
    accept: "application/json",
    ...config.headers,
    "content-type": "application/json",
  }
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`
  }

  const fetchImpl = config.fetch ?? globalThis.fetch
  const signal = request.signal
  if (signal?.aborted === true) {
    return yield* Effect.fail(abortedError())
  }

  return yield* Effect.tryPromise({
    try: async (effectSignal) => {
      const controller = new AbortController()
      let timedOut = false
      const abort = (): void => controller.abort()
      effectSignal.addEventListener("abort", abort, { once: true })
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted === true || effectSignal.aborted) {
        abort()
      }
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)

      try {
        const response = await fetchImpl(resolved.endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        })

        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => undefined)
          throw httpStatusError(response.status)
        }

        const raw = await readBoundedBody(response, maxResponseBytes)
        return { content: assistantContent(raw) }
      } catch (cause) {
        if (cause instanceof ModelTransportError) {
          throw cause
        }
        if (timedOut) {
          throw timeoutError(timeoutMs)
        }
        if (signal?.aborted === true || effectSignal.aborted) {
          throw abortedError()
        }
        throw networkError()
      } finally {
        clearTimeout(timer)
        effectSignal.removeEventListener("abort", abort)
        signal?.removeEventListener("abort", abort)
      }
    },
    catch: (cause) =>
      cause instanceof ModelTransportError ? cause : networkError(),
  })
})

/**
 * Builds the transport for explicit maintenance and recall callers. The
 * provider URL and model are never inferred, and no tools are sent.
 */
export const makeOpenAiCompatibleTransport = (
  config: OpenAiCompatibleProviderConfig,
): ModelTransport => ({
  chat: (request) => requestModelChat(config, request),
})
