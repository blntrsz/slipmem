import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { PRIMARY_CHAT_ENV_NAMES } from "@slipmem/mcp"
import { spawn, spawnSync } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { resolve } from "node:path"

/**
 * A narrow, opt-in Git-push ingress for a long-lived slipmem process.
 *
 * It is not a GitHub webhook. The caller is a trusted automation job that
 * forwards only exact commit SHAs. The server never accepts a filesystem path,
 * a branch name, a diff, or a command from the caller. It runs an
 * operator-configured, first-party capture command in a separately configured,
 * trusted local Git checkout; that command writes durable fleeting notes, and
 * the MCP maintenance watcher drains them from the same note root. The ingress
 * never reads a diff, checks out a commit, or executes a file from the pushed
 * tree; it substitutes only validated SHAs and the configured trusted root.
 *
 * The endpoint is absent unless `SLIPMEM_GIT_INGRESS=on` and every required
 * value resolves. It has a separate bearer token and is not protected by, or a
 * substitute for, the unauthenticated local JSON API.
 */
export const GIT_INGRESS_PATH = "/api/hooks/git-push"

export const GIT_INGRESS_ENV = {
  enabled: "SLIPMEM_GIT_INGRESS",
  token: "SLIPMEM_GIT_INGRESS_TOKEN",
  tokenFile: "SLIPMEM_GIT_INGRESS_TOKEN_FILE",
  repository: "SLIPMEM_GIT_INGRESS_REPO",
  command: "SLIPMEM_GIT_INGRESS_COMMAND",
  timeoutMs: "SLIPMEM_GIT_INGRESS_TIMEOUT_MS",
  maxCommits: "SLIPMEM_GIT_INGRESS_MAX_COMMITS",
  captureProvider: "SLIPMEM_CAPTURE_PROVIDER",
  captureModel: "SLIPMEM_CAPTURE_MODEL",
  captureBaseUrl: "SLIPMEM_CAPTURE_BASE_URL",
} as const

/** Request bodies are only a SHA list; 16 KiB is generous and bounded. */
const MAX_BODY_BYTES = 16 * 1024
const MIN_TOKEN_CHARS = 32
const MAX_TOKEN_BYTES = 4 * 1024
const MAX_COMMAND_ARGS = 64
const MAX_COMMAND_ARG_CHARS = 4_096
const MAX_OUTPUT_BYTES = 16 * 1024
const MAX_QUEUE_DEPTH = 4
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_COMMITS = 20
const MAX_MAX_COMMITS = 100
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export interface GitIngressDisabled {
  readonly enabled: false
}

export interface GitIngressEnabled {
  readonly enabled: true
  readonly path: typeof GIT_INGRESS_PATH
  /**
   * Canonical trusted Git worktree root. This value comes only from operator
   * configuration, never from an HTTP caller.
   */
  readonly repository: string
  /** Kept server-side; never logged, echoed, or passed to a child process. */
  readonly token: string
  /** Trusted argv template with `{before}`, `{after}`, `{repository}` tokens. */
  readonly command: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly maxCommits: number
  /** Safe display label for the capture provider, for startup notices. */
  readonly captureModel: string
  readonly captureEgress: "local" | "remote"
}

export type GitIngressConfig = GitIngressDisabled | GitIngressEnabled

const configError = (message: string): Error =>
  new Error(`Git ingress configuration: ${message}`)

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

const booleanValue = (raw: string | undefined): boolean => {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === "" || value === "0" || value === "false" || value === "off") {
    return false
  }
  if (value === "1" || value === "true" || value === "on") {
    return true
  }
  throw configError(
    `${GIT_INGRESS_ENV.enabled} must be on or off; received '${raw}'.`,
  )
}

const integerValue = (
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = raw?.trim()
  if (value === undefined || value === "") {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configError(
      `${name} must be an integer from ${minimum} to ${maximum}; received '${value}'.`,
    )
  }
  return parsed
}

const readToken = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const inline = env[GIT_INGRESS_ENV.token]?.trim()
  const file = env[GIT_INGRESS_ENV.tokenFile]?.trim()
  if (inline !== undefined && inline !== "" && file !== undefined && file !== "") {
    throw configError(
      `Set either ${GIT_INGRESS_ENV.token} or ${GIT_INGRESS_ENV.tokenFile}, not both.`,
    )
  }
  if (inline !== undefined && inline !== "") {
    return inline
  }
  if (file === undefined || file === "") {
    throw configError(
      `${GIT_INGRESS_ENV.token} (or ${GIT_INGRESS_ENV.tokenFile}) is required. The ingress is not exposed without a separate bearer token.`,
    )
  }

  const absolute = resolve(file)
  try {
    const size = statSync(absolute).size
    if (size > MAX_TOKEN_BYTES) {
      throw configError(
        `${GIT_INGRESS_ENV.tokenFile} must contain at most ${MAX_TOKEN_BYTES} bytes.`,
      )
    }
    return readFileSync(absolute, "utf8").trim()
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Git ingress configuration:")) {
      throw cause
    }
    throw configError(
      `Could not read ${GIT_INGRESS_ENV.tokenFile} at ${absolute}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

const readRepository = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const raw = env[GIT_INGRESS_ENV.repository]?.trim()
  if (raw === undefined || raw === "") {
    throw configError(
      `${GIT_INGRESS_ENV.repository} is required and must name a trusted local Git worktree.`,
    )
  }
  const absolute = resolve(raw)
  try {
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error("the path does not exist or is not a directory")
    }
  } catch (cause) {
    throw configError(
      `${GIT_INGRESS_ENV.repository} is not a readable directory: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }

  const result = spawnSync("git", ["-C", absolute, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  if (result.status !== 0) {
    throw configError(
      `${GIT_INGRESS_ENV.repository} must be a Git worktree; "git rev-parse --show-toplevel" failed.`,
    )
  }
  const topLevel = result.stdout.trim()
  if (topLevel === "") {
    throw configError(
      `${GIT_INGRESS_ENV.repository} did not report a Git worktree root.`,
    )
  }
  const canonical = realpathSync(topLevel)
  if (!statSync(canonical).isDirectory()) {
    throw configError(
      `${GIT_INGRESS_ENV.repository} does not resolve to a directory.`,
    )
  }
  return canonical
}

const readCommand = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const raw = env[GIT_INGRESS_ENV.command]?.trim()
  if (raw === undefined || raw === "") {
    throw configError(
      `${GIT_INGRESS_ENV.command} is required and must be a JSON array of trusted argv strings.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw configError(
      `${GIT_INGRESS_ENV.command} must be a JSON array of strings.`,
    )
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_COMMAND_ARGS ||
    parsed.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_COMMAND_ARG_CHARS ||
        value.includes("\u0000"),
    )
  ) {
    throw configError(
      `${GIT_INGRESS_ENV.command} must be a non-empty JSON array of 1..${MAX_COMMAND_ARGS} non-empty strings.`,
    )
  }
  const command = parsed as ReadonlyArray<string>
  const joined = command.join("\u0000")
  if (!joined.includes("{before}") || !joined.includes("{after}")) {
    throw configError(
      `${GIT_INGRESS_ENV.command} must contain both {before} and {after} placeholders so the caller's SHAs reach the capture command.`,
    )
  }
  return command
}

const readCaptureModel = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly label: string; readonly egress: "local" | "remote" } => {
  const provider = firstValue(
    env[GIT_INGRESS_ENV.captureProvider],
    env[PRIMARY_CHAT_ENV_NAMES.provider],
    env[PRIMARY_CHAT_ENV_NAMES.legacyProvider],
  )?.toLowerCase()
  if (provider !== "openai-compatible") {
    throw configError(
      `${GIT_INGRESS_ENV.captureProvider}=openai-compatible (or ${PRIMARY_CHAT_ENV_NAMES.provider}=openai-compatible) is required when the ingress is enabled. There is no default capture model.`,
    )
  }
  const model = firstValue(
    env[GIT_INGRESS_ENV.captureModel],
    env[PRIMARY_CHAT_ENV_NAMES.model],
    env[PRIMARY_CHAT_ENV_NAMES.legacyModel],
  )
  if (model === undefined) {
    throw configError(
      `${GIT_INGRESS_ENV.captureModel} or ${PRIMARY_CHAT_ENV_NAMES.model} is required when the ingress is enabled.`,
    )
  }
  const rawBaseUrl = firstValue(
    env[GIT_INGRESS_ENV.captureBaseUrl],
    env[PRIMARY_CHAT_ENV_NAMES.baseUrl],
    env[PRIMARY_CHAT_ENV_NAMES.legacyBaseUrl],
  )
  if (rawBaseUrl === undefined) {
    throw configError(
      `${GIT_INGRESS_ENV.captureBaseUrl} or ${PRIMARY_CHAT_ENV_NAMES.baseUrl} is required when the ingress is enabled.`,
    )
  }
  let url: URL
  try {
    url = new URL(rawBaseUrl)
  } catch {
    throw configError(
      `${GIT_INGRESS_ENV.captureBaseUrl} or ${PRIMARY_CHAT_ENV_NAMES.baseUrl} must be an absolute HTTPS URL, or HTTP only on a loopback host.`,
    )
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.protocol === "http:" && !isLoopbackHost(url.hostname)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw configError(
      `${GIT_INGRESS_ENV.captureBaseUrl} or ${PRIMARY_CHAT_ENV_NAMES.baseUrl} must use HTTPS (or HTTP on loopback), contain no credentials, query string, or fragment.`,
    )
  }
  return {
    label: `${model} at ${url.origin}`,
    egress: isLoopbackHost(url.hostname) ? "local" : "remote",
  }
}

/**
 * Resolves the optional Git ingress. Disabled is the default and reads no
 * token, touches no repository, and adds no route. Enabling it requires a
 * separate token, a trusted Git worktree, an explicit capture command, and an
 * explicit tool-less capture model. Model values fall back from the capture
 * names to the shared primary chat configuration (`SLIPMEM_CHAT_*`, then the
 * legacy `SLIPMEM_MAINTENANCE_*` names).
 */
export const resolveGitIngressConfig = (
  env: Readonly<Record<string, string | undefined>>,
): GitIngressConfig => {
  if (!booleanValue(env[GIT_INGRESS_ENV.enabled])) {
    return { enabled: false }
  }

  const token = readToken(env)
  if (token.length < MIN_TOKEN_CHARS) {
    throw configError(
      `${GIT_INGRESS_ENV.token} must be at least ${MIN_TOKEN_CHARS} characters; use a random value and do not reuse another credential.`,
    )
  }
  if (/\s/.test(token)) {
    throw configError(
      `${GIT_INGRESS_ENV.token} must not contain whitespace; a bearer header cannot carry it.`,
    )
  }
  const repository = readRepository(env)
  const command = readCommand(env)
  const capture = readCaptureModel(env)

  return {
    enabled: true,
    path: GIT_INGRESS_PATH,
    repository,
    token,
    command,
    timeoutMs: integerValue(
      env[GIT_INGRESS_ENV.timeoutMs],
      GIT_INGRESS_ENV.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxCommits: integerValue(
      env[GIT_INGRESS_ENV.maxCommits],
      GIT_INGRESS_ENV.maxCommits,
      DEFAULT_MAX_COMMITS,
      1,
      MAX_MAX_COMMITS,
    ),
    captureModel: capture.label,
    captureEgress: capture.egress,
  }
}

/** The startup disclosure never includes the token or note contents. */
export const formatGitIngressNotice = (
  config: GitIngressConfig,
  maintenanceEnabled = false,
): string | undefined => {
  if (!config.enabled) {
    return undefined
  }
  return [
    `slipmem git ingress: enabled at POST ${config.path}; it accepts only exact commit SHAs behind a separate bearer token.`,
    `Trusted local Git worktree: ${config.repository}. The capture command runs with the server's note root and writes durable fleeting sources. The trusted checkout must already be at the pushed after commit; capture never fetches, resets, or checks out.`,
    "Run a first-party installed capture command with absolute paths, never a script or wrapper inside the pushed checkout. The child receives only an allowlisted capture/chat environment, not unrelated server credentials.",
    maintenanceEnabled
      ? "The in-process maintenance watcher is enabled and will drain captured sources after the durable write."
      : "No in-process maintenance runtime is enabled. Captured sources remain durable, but consolidation waits for an MCP serve process with its required primary chat model.",
    `Capture model: ${config.captureModel} (${config.captureEgress === "remote" ? "remote egress" : "local loopback"}). The endpoint is absent unless ${GIT_INGRESS_ENV.enabled}=on.`,
    "If this path is exposed outside the host, terminate TLS and route only this exact path to the local server. The rest of the JSON API and /mcp are unauthenticated and must not be exposed with it.",
  ].join("\n")
}

/* -------------------------------------------------------------------------- */
/* Capture command boundary                                                   */
/* -------------------------------------------------------------------------- */

export interface GitIngressRunInput {
  /** Canonical trusted worktree root from configuration. */
  readonly repository: string
  /** The server's resolved note root; set as SLIPMEM_DIR for the child. */
  readonly noteRoot: string
  readonly before: string
  readonly after: string
  readonly commits: ReadonlyArray<string>
  /** Aborted when the HTTP handler is interrupted during shutdown/reload. */
  readonly signal?: AbortSignal
}

export interface GitIngressRunResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly outputTruncated: boolean
}

/** Test seam; production uses the configured, trusted argv command. */
export type GitIngressRunner = (
  input: GitIngressRunInput,
) => Promise<GitIngressRunResult>

const substituteCommand = (
  command: ReadonlyArray<string>,
  input: GitIngressRunInput,
): ReadonlyArray<string> =>
  command.map((argument) =>
    argument
      .replaceAll("{before}", input.before)
      .replaceAll("{after}", input.after)
      .replaceAll("{repository}", input.repository),
  )

/**
 * Only these ambient values reach the capture child. The server process may
 * hold unrelated cloud, database, and provider credentials; none of them belong
 * in a Git-delta capture command. `SLIPMEM_CAPTURE_*`, the shared
 * `SLIPMEM_CHAT_*` fallback, and the legacy aliases are the only note/model
 * settings the command needs. TLS trust paths are read-only configuration, not
 * credentials.
 */
const CHILD_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const

const CHILD_CAPTURE_ENV_KEYS = [
  "SLIPMEM_CAPTURE_PROVIDER",
  "SLIPMEM_CAPTURE_MODEL",
  "SLIPMEM_CAPTURE_BASE_URL",
  "SLIPMEM_CAPTURE_API_KEY",
  "SLIPMEM_CAPTURE_TIMEOUT_MS",
  "SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES",
  "SLIPMEM_CAPTURE_MAX_FILES",
  "SLIPMEM_CAPTURE_MAX_HUNKS",
  "SLIPMEM_CAPTURE_MAX_FILE_CHARS",
  "SLIPMEM_CAPTURE_MAX_DIFF_CHARS",
  "SLIPMEM_CAPTURE_MAX_HUNK_LINE_CHARS",
  "SLIPMEM_CAPTURE_MAX_SOURCES",
  "SLIPMEM_CAPTURE_MAX_EVIDENCE",
  "SLIPMEM_CHAT_PROVIDER",
  "SLIPMEM_CHAT_MODEL",
  "SLIPMEM_CHAT_BASE_URL",
  "SLIPMEM_CHAT_API_KEY",
  "SLIPMEM_MAINTENANCE_PROVIDER",
  "SLIPMEM_MAINTENANCE_MODEL",
  "SLIPMEM_MAINTENANCE_BASE_URL",
  "SLIPMEM_MAINTENANCE_API_KEY",
] as const

const childEnvironment = (
  noteRoot: string,
  input: GitIngressRunInput,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of [...CHILD_SAFE_ENV_KEYS, ...CHILD_CAPTURE_ENV_KEYS]) {
    const value = process.env[key]
    if (typeof value === "string") {
      env[key] = value
    }
  }
  return {
    ...env,
    SLIPMEM_DIR: noteRoot,
    SLIPMEM_GIT_BEFORE: input.before,
    SLIPMEM_GIT_AFTER: input.after,
    SLIPMEM_GIT_REPOSITORY: input.repository,
    SLIPMEM_GIT_COMMITS: JSON.stringify(input.commits),
  }
}

const makeSpawnCapture =
  (config: GitIngressEnabled): GitIngressRunner =>
  (input) =>
  new Promise((resolveRun) => {
    const argv = substituteCommand(config.command, input)
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputTruncated = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const abort = (): void => {
      child.kill("SIGKILL")
      finish({ exitCode: null, timedOut: false, outputTruncated })
    }

    const finish = (result: GitIngressRunResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      input.signal?.removeEventListener("abort", abort)
      resolveRun(result)
    }

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: input.repository,
      env: childEnvironment(input.noteRoot, input),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    })

    if (input.signal?.aborted === true) {
      abort()
      return
    }
    input.signal?.addEventListener("abort", abort, { once: true })

    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ exitCode: null, timedOut: true, outputTruncated })
    }, config.timeoutMs)
    timer.unref?.()

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputTruncated = true
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        outputTruncated = true
      }
    })
    child.on("error", () => {
      finish({ exitCode: null, timedOut: false, outputTruncated })
    })
    child.on("exit", (code) => {
      finish({ exitCode: code, timedOut: false, outputTruncated })
    })
  })

/* -------------------------------------------------------------------------- */
/* HTTP admission and validation                                              */
/* -------------------------------------------------------------------------- */

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const

const jsonResponse = (body: unknown, status: number, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { ...noStoreHeaders, ...headers },
  })

const unauthorized = () =>
  jsonResponse(
    {
      ok: false,
      code: "unauthorized",
      message: "A bearer token is required.",
    },
    401,
    { "www-authenticate": "Bearer" },
  )

const badRequest = (code: string, message: string) =>
  jsonResponse({ ok: false, code, message }, 400)

const bearerToken = (header: string | undefined): string | undefined => {
  if (header === undefined) {
    return undefined
  }
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(header.trim())
  return match?.[1]
}

const tokenMatches = (provided: string, expected: string): boolean => {
  const left = createHash("sha256").update(provided, "utf8").digest()
  const right = createHash("sha256").update(expected, "utf8").digest()
  return timingSafeEqual(left, right)
}

interface GitPushPayload {
  readonly before: string
  readonly after: string
  readonly commits: ReadonlyArray<string>
}

const isSha = (value: unknown): value is string =>
  typeof value === "string" &&
  SHA_PATTERN.test(value) &&
  !/^0+$/.test(value)

const parsePayload = (
  body: Readonly<Record<string, unknown>>,
  maxCommits: number,
): { readonly ok: true; readonly value: GitPushPayload } | { readonly ok: false; readonly code: string; readonly message: string } => {
  const allowed = new Set(["before", "after", "commits"])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: "invalid-field",
        message: `Unexpected field '${key}'. The ingress accepts only before, after, and commits as exact commit SHAs.`,
      }
    }
  }
  const before = body.before
  const after = body.after
  if (!isSha(before)) {
    return {
      ok: false,
      code: "invalid-before",
      message:
        "before must be an exact lowercase 40- or 64-character commit SHA, not a branch, tag, short SHA, or all-zero sentinel.",
    }
  }
  if (!isSha(after)) {
    return {
      ok: false,
      code: "invalid-after",
      message:
        "after must be an exact lowercase 40- or 64-character commit SHA, not a branch, tag, short SHA, or all-zero sentinel.",
    }
  }

  const rawCommits = body.commits
  if (rawCommits === undefined) {
    return { ok: true, value: { before, after, commits: [] } }
  }
  if (!Array.isArray(rawCommits)) {
    return {
      ok: false,
      code: "invalid-commits",
      message: "commits must be an array of exact commit SHAs.",
    }
  }
  if (rawCommits.length > maxCommits) {
    return {
      ok: false,
      code: "too-many-commits",
      message: `commits must contain at most ${maxCommits} entries.`,
    }
  }
  const commits: string[] = []
  const seen = new Set<string>()
  for (const value of rawCommits) {
    if (!isSha(value)) {
      return {
        ok: false,
        code: "invalid-commits",
        message:
          "Every commits entry must be an exact lowercase 40- or 64-character commit SHA, not a path or arbitrary string.",
      }
    }
    if (!seen.has(value)) {
      seen.add(value)
      commits.push(value)
    }
  }
  return { ok: true, value: { before, after, commits } }
}

const readPayload = (
  request: HttpServerRequest.HttpServerRequest,
  maxCommits: number,
): Effect.Effect<
  | { readonly ok: true; readonly value: GitPushPayload }
  | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse }
> =>
  Effect.gen(function* () {
    const contentType = request.headers["content-type"]
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase()
    if (mediaType !== "application/json") {
      return {
        ok: false as const,
        response: jsonResponse(
          {
            ok: false,
            code: "invalid-content-type",
            message: "The ingress requires an application/json body.",
          },
          415,
        ),
      }
    }

    const declared = Number(request.headers["content-length"] ?? "0")
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return {
        ok: false as const,
        response: jsonResponse(
          {
            ok: false,
            code: "body-too-large",
            message: `The request body must be at most ${MAX_BODY_BYTES} bytes.`,
          },
          413,
        ),
      }
    }

    // Decode incrementally and stop the upstream stream as soon as the byte
    // cap is crossed. Never buffer an unbounded caller body just to reject it.
    const decoder = new TextDecoder()
    const parts: string[] = []
    let bytes = 0
    let tooLarge = false
    let readFailed = false
    yield* Stream.runForEachWhile(request.stream, (chunk) =>
      Effect.sync(() => {
        bytes += chunk.byteLength
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true
          return false
        }
        parts.push(decoder.decode(chunk, { stream: true }))
        return true
      }),
    ).pipe(
      Effect.catch(() => {
        readFailed = true
        return Effect.void
      }),
    )
    if (tooLarge) {
      return {
        ok: false as const,
        response: jsonResponse(
          {
            ok: false,
            code: "body-too-large",
            message: `The request body must be at most ${MAX_BODY_BYTES} bytes.`,
          },
          413,
        ),
      }
    }
    if (readFailed) {
      return {
        ok: false as const,
        response: badRequest("invalid-body", "Could not read the request body."),
      }
    }
    const text = parts.join("") + decoder.decode()

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false as const,
        response: badRequest("invalid-body", "Expected a JSON object."),
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false as const,
        response: badRequest("invalid-body", "Expected a JSON object."),
      }
    }

    const payload = parsePayload(
      parsed as Readonly<Record<string, unknown>>,
      maxCommits,
    )
    return payload.ok
      ? { ok: true as const, value: payload.value }
      : {
          ok: false as const,
          response: badRequest(payload.code, payload.message),
        }
  })

export interface GitIngressOptions {
  readonly config: GitIngressEnabled
  /** The same resolved note root the MCP maintenance watcher observes. */
  readonly noteRoot: string
  /** Whether this process also runs the event-driven consolidation watcher. */
  readonly maintenanceEnabled?: boolean
  /** Test seam; production runs the configured trusted command. */
  readonly run?: GitIngressRunner
}

type GitIngressRunOutcome =
  | GitIngressRunResult
  | (GitIngressRunResult & { readonly busy: true })

const makeSerializedRunner = (
  runner: GitIngressRunner,
): ((input: GitIngressRunInput) => Promise<GitIngressRunOutcome>) => {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0

  return (input) => {
    if (queued >= MAX_QUEUE_DEPTH) {
      return Promise.resolve({
        exitCode: null,
        timedOut: false,
        outputTruncated: false,
        busy: true as const,
      })
    }
    queued += 1
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolveTail) => {
      release = resolveTail
    })
    return previous
      .then(
        () => runner(input),
        () => runner(input),
      )
      .finally(() => {
        release()
        queued -= 1
      })
  }
}

/**
 * Builds the request handler. Exported for focused tests; production mounts it
 * as a route with `makeGitIngressLayer`.
 */
export const makeGitIngressHandler = (
  options: GitIngressOptions,
): ((
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>) => {
  const { config, noteRoot } = options
  const runner = makeSerializedRunner(
    options.run ?? makeSpawnCapture(config),
  )

  return (request) =>
    Effect.gen(function* () {
      if (request.headers["origin"] !== undefined) {
        return jsonResponse(
          {
            ok: false,
            code: "cross-origin",
            message: "The Git ingress does not accept browser origins.",
          },
          403,
        )
      }

      const provided = bearerToken(request.headers["authorization"])
      if (provided === undefined || !tokenMatches(provided, config.token)) {
        return unauthorized()
      }

      const payload = yield* readPayload(request, config.maxCommits)
      if (!payload.ok) {
        return payload.response
      }

      const controller = new AbortController()
      const result = yield* Effect.tryPromise({
        try: () =>
          runner({
            repository: config.repository,
            noteRoot,
            before: payload.value.before,
            after: payload.value.after,
            commits: payload.value.commits,
            signal: controller.signal,
          }),
        catch: () => null,
      }).pipe(
        // Shutdown, HMR, or a dropped request must not leave a capture child
        // running until its timeout.
        Effect.ensuring(Effect.sync(() => controller.abort())),
        Effect.catch(() =>
          Effect.succeed({
            exitCode: null,
            timedOut: false,
            outputTruncated: false,
          } as GitIngressRunResult),
        ),
      )

      if ("busy" in result && result.busy === true) {
        return jsonResponse(
          {
            ok: false,
            code: "capture-busy",
            message: "Another capture is running; retry the push event.",
          },
          429,
          { "retry-after": "30" },
        )
      }

      if (result.timedOut) {
        process.stderr.write(
          `slipmem git ingress: capture command timed out after ${config.timeoutMs}ms for ${payload.value.before.slice(0, 12)}..${payload.value.after.slice(0, 12)}.\n`,
        )
        return jsonResponse(
          {
            ok: false,
            code: "capture-timeout",
            message: "Git capture did not finish before the configured timeout.",
          },
          504,
        )
      }

      if (result.exitCode !== 0) {
        process.stderr.write(
          `slipmem git ingress: capture command failed with exit code ${String(result.exitCode)} for ${payload.value.before.slice(0, 12)}..${payload.value.after.slice(0, 12)}; stderr and stdout are suppressed.\n`,
        )
        return jsonResponse(
          {
            ok: false,
            code: "capture-failed",
            message:
              "Git capture failed; the server suppressed command output. Re-run the same first-party capture command manually on the trusted host for details, or retry the same SHA-only event. Never send a filesystem path or diff.",
          },
          502,
        )
      }

      return jsonResponse(
        {
          ok: true,
          status: "captured",
          before: payload.value.before,
          after: payload.value.after,
          commits: payload.value.commits,
          durable: true,
          consolidation:
            options.maintenanceEnabled === true
              ? "queued for the in-process maintenance watcher"
              : options.maintenanceEnabled === false
                ? "awaiting a maintenance runtime"
                : "available for the next maintenance pass",
        },
        200,
      )
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          jsonResponse(
            {
              ok: false,
              code: "internal",
              message: "The Git ingress could not process the request.",
            },
            500,
          ),
        ),
      ),
    )
}

/**
 * Adds the route only when `resolveGitIngressConfig` returned an enabled config.
 * The caller must not mount anything for the disabled case, so the default host
 * has no ingress route at all.
 */
export const makeGitIngressLayer = (
  options: GitIngressOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const handler = makeGitIngressHandler(options)
  return HttpRouter.add("POST", options.config.path, handler)
}
