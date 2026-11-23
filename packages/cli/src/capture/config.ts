import {
  MAX_MODEL_RESPONSE_BYTES,
  MAX_MODEL_TIMEOUT_MS,
  makeOpenAiCompatibleTransport,
  type ModelTransport,
} from "@slipmem/core/model"
import { GitCaptureError, gitCaptureError } from "./errors.js"
import type { GitDiffLimits } from "./git.js"

export interface CaptureLimits extends GitDiffLimits {
  readonly maxSources: number
  readonly maxEvidencePerSource: number
  readonly maxSourceContentChars: number
  readonly maxSourceTitleChars: number
  readonly maxSourceTags: number
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxFiles: 24,
  maxHunksPerFile: 20,
  maxFilePatchChars: 12_000,
  maxTotalPatchChars: 60_000,
  maxHunkLineChars: 2_000,
  maxSources: 4,
  maxEvidencePerSource: 4,
  maxSourceContentChars: 1_000,
  maxSourceTitleChars: 300,
  maxSourceTags: 16,
}

type ParsedInteger =
  | { readonly value: number }
  | { readonly error: GitCaptureError }

/**
 * Parses an optional bounded integer environment value. An absent or blank
 * value means "use the fallback"; anything else must be a safe integer inside
 * the documented range. Invalid values are typed configuration failures, never
 * `NaN` passed through to the model transport.
 */
const parseInteger = (
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): ParsedInteger | undefined => {
  const value = raw?.trim()
  if (value === undefined || value === "") {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: name,
        message: `${name} must be an integer from ${minimum} to ${maximum}; received '${value}'.`,
      }),
    }
  }
  return { value: parsed }
}

const integerFromEnv = (
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = parseInteger(raw, name, minimum, maximum)
  if (parsed === undefined) {
    return fallback
  }
  if ("error" in parsed) {
    throw parsed.error
  }
  return parsed.value
}

const envLimits = (
  env: Readonly<Record<string, string | undefined>>,
): CaptureLimits => ({
  maxFiles: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_FILES,
    "SLIPMEM_CAPTURE_MAX_FILES",
    DEFAULT_CAPTURE_LIMITS.maxFiles,
    1,
    100,
  ),
  maxHunksPerFile: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_HUNKS,
    "SLIPMEM_CAPTURE_MAX_HUNKS",
    DEFAULT_CAPTURE_LIMITS.maxHunksPerFile,
    1,
    50,
  ),
  maxFilePatchChars: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_FILE_CHARS,
    "SLIPMEM_CAPTURE_MAX_FILE_CHARS",
    DEFAULT_CAPTURE_LIMITS.maxFilePatchChars,
    1_000,
    50_000,
  ),
  maxTotalPatchChars: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_DIFF_CHARS,
    "SLIPMEM_CAPTURE_MAX_DIFF_CHARS",
    DEFAULT_CAPTURE_LIMITS.maxTotalPatchChars,
    2_000,
    200_000,
  ),
  maxHunkLineChars: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_HUNK_LINE_CHARS,
    "SLIPMEM_CAPTURE_MAX_HUNK_LINE_CHARS",
    DEFAULT_CAPTURE_LIMITS.maxHunkLineChars,
    200,
    8_000,
  ),
  maxSources: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_SOURCES,
    "SLIPMEM_CAPTURE_MAX_SOURCES",
    DEFAULT_CAPTURE_LIMITS.maxSources,
    1,
    8,
  ),
  maxEvidencePerSource: integerFromEnv(
    env.SLIPMEM_CAPTURE_MAX_EVIDENCE,
    "SLIPMEM_CAPTURE_MAX_EVIDENCE",
    DEFAULT_CAPTURE_LIMITS.maxEvidencePerSource,
    1,
    8,
  ),
  maxSourceContentChars: DEFAULT_CAPTURE_LIMITS.maxSourceContentChars,
  maxSourceTitleChars: DEFAULT_CAPTURE_LIMITS.maxSourceTitleChars,
  maxSourceTags: DEFAULT_CAPTURE_LIMITS.maxSourceTags,
})

export const resolveCaptureLimits = (
  env: Readonly<Record<string, string | undefined>>,
): CaptureLimits | { readonly error: GitCaptureError } => {
  try {
    return envLimits(env)
  } catch (cause) {
    if (cause instanceof GitCaptureError) {
      return { error: cause }
    }
    return {
      error: gitCaptureError({
        code: "invalid-config",
        message: `Could not resolve capture limits: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    }
  }
}

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
      (octet) => /^\d{1,3}$/.test(octet) && Number.parseInt(octet, 10) <= 255,
    )
  )
}

const firstValue = (
  ...values: ReadonlyArray<string | undefined>
): string | undefined => {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed !== "") {
      return trimmed
    }
  }
  return undefined
}

export type CaptureEgress = "local" | "remote"

export interface CaptureModelRuntime {
  readonly transport: ModelTransport
  /** Safe display label; never contains a credential or query string. */
  readonly label: string
  readonly egress: CaptureEgress
}

/**
 * Requires an explicit OpenAI-compatible endpoint. There is no default
 * provider, URL, model, or automatic egress. Capture-specific
 * `SLIPMEM_CAPTURE_*` values win; missing values fall back to the shared
 * primary chat configuration (`SLIPMEM_CHAT_*`, then legacy
 * `SLIPMEM_MAINTENANCE_*`). The transport never offers tools.
 */
export const resolveCaptureModel = (
  env: Readonly<Record<string, string | undefined>>,
): CaptureModelRuntime | { readonly error: GitCaptureError } => {
  const provider = firstValue(
    env.SLIPMEM_CAPTURE_PROVIDER,
    env.SLIPMEM_CHAT_PROVIDER,
    env.SLIPMEM_MAINTENANCE_PROVIDER,
  )?.toLowerCase()
  if (provider !== "openai-compatible") {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: "SLIPMEM_CAPTURE_PROVIDER",
        message:
          "Git capture requires SLIPMEM_CAPTURE_PROVIDER=openai-compatible or the shared SLIPMEM_CHAT_PROVIDER=openai-compatible. There is no default provider or model.",
      }),
    }
  }

  const model = firstValue(
    env.SLIPMEM_CAPTURE_MODEL,
    env.SLIPMEM_CHAT_MODEL,
    env.SLIPMEM_MAINTENANCE_MODEL,
  )
  if (model === undefined) {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: "SLIPMEM_CAPTURE_MODEL",
        message:
          "SLIPMEM_CAPTURE_MODEL or the shared SLIPMEM_CHAT_MODEL is required for Git capture.",
      }),
    }
  }

  const baseUrl = firstValue(
    env.SLIPMEM_CAPTURE_BASE_URL,
    env.SLIPMEM_CHAT_BASE_URL,
    env.SLIPMEM_MAINTENANCE_BASE_URL,
  )
  if (baseUrl === undefined) {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: "SLIPMEM_CAPTURE_BASE_URL",
        message:
          "SLIPMEM_CAPTURE_BASE_URL or the shared SLIPMEM_CHAT_BASE_URL is required for Git capture. No provider URL is assumed.",
      }),
    }
  }

  let endpoint: URL
  try {
    endpoint = new URL(baseUrl)
  } catch {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: "SLIPMEM_CAPTURE_BASE_URL",
        message:
          "SLIPMEM_CAPTURE_BASE_URL or the shared SLIPMEM_CHAT_BASE_URL must be an absolute HTTPS URL, or HTTP only for a loopback host.",
      }),
    }
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    return {
      error: gitCaptureError({
        code: "invalid-config",
        field: "SLIPMEM_CAPTURE_BASE_URL",
        message:
          "SLIPMEM_CAPTURE_BASE_URL or the shared SLIPMEM_CHAT_BASE_URL must use HTTPS (or HTTP on loopback), contain no credentials, query string, or fragment.",
      }),
    }
  }

  const timeout = parseInteger(
    env.SLIPMEM_CAPTURE_TIMEOUT_MS,
    "SLIPMEM_CAPTURE_TIMEOUT_MS",
    1,
    MAX_MODEL_TIMEOUT_MS,
  )
  if (timeout !== undefined && "error" in timeout) {
    return { error: timeout.error }
  }
  const maxResponseBytes = parseInteger(
    env.SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES,
    "SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES",
    1,
    MAX_MODEL_RESPONSE_BYTES,
  )
  if (maxResponseBytes !== undefined && "error" in maxResponseBytes) {
    return { error: maxResponseBytes.error }
  }
  const apiKey = firstValue(
    env.SLIPMEM_CAPTURE_API_KEY,
    env.SLIPMEM_CHAT_API_KEY,
    env.SLIPMEM_MAINTENANCE_API_KEY,
  )

  const transport = makeOpenAiCompatibleTransport({
    baseUrl,
    model,
    ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout.value }),
    ...(maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: maxResponseBytes.value }),
  })

  return {
    transport,
    label: `${model} at ${endpoint.origin}`,
    egress: isLoopbackHost(endpoint.hostname) ? "local" : "remote",
  }
}
