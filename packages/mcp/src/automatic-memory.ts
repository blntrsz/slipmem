import {
  MarkdownNoteRepository,
  PermanentMaintenanceWorker,
  atomicWriteFile,
  makeChatPromptRecallEvaluator,
  makeJevDecisionPromptRecallEvaluator,
  makePromptMaintenanceProvider,
  managedPermanentMetadata,
  STATE_DIRECTORY,
  type MaintenanceProvider,
  type MaintenanceRunResult,
  type MarkdownError,
  type MarkdownNoteRepositoryShape,
  type PromptRecallEvaluator,
} from "@slipmem/core"
import {
  makeOpenAiCompatibleTransport,
  type ModelTransport,
} from "@slipmem/core/model"
import {
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Queue,
  Redacted,
  Scope,
} from "effect"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  watch,
  writeSync,
  type FSWatcher,
} from "node:fs"
import { join } from "node:path"

/** A pinned Jev model is safer than silently tracking an unpinned alias. */
export const DEFAULT_RECALL_JEV_MODEL = "jev-1.13.0"

/**
 * Canonical environment names for the memory runtime's primary chat model.
 * The legacy maintenance names remain accepted so existing operator
 * configurations keep working; the ingress/extraction path should use these
 * names or `resolvePrimaryChatModel`.
 */
export const PRIMARY_CHAT_ENV_NAMES = {
  provider: "SLIPMEM_CHAT_PROVIDER",
  baseUrl: "SLIPMEM_CHAT_BASE_URL",
  model: "SLIPMEM_CHAT_MODEL",
  apiKey: "SLIPMEM_CHAT_API_KEY",
  legacyProvider: "SLIPMEM_MAINTENANCE_PROVIDER",
  legacyBaseUrl: "SLIPMEM_MAINTENANCE_BASE_URL",
  legacyModel: "SLIPMEM_MAINTENANCE_MODEL",
  legacyApiKey: "SLIPMEM_MAINTENANCE_API_KEY",
} as const

export type AutomaticMemoryEgress = "local" | "remote"

/**
 * The single configured chat model used by automatic memory and, unless Jev is
 * explicitly selected, by structured per-note prompt recall. It is a bounded,
 * tool-less chat-completion transport; it has no filesystem or approval power.
 */
export interface PrimaryChatModel {
  readonly model: string
  /** Safe display label; never contains a credential or query string. */
  readonly label: string
  readonly egress: AutomaticMemoryEgress
  readonly chat: ModelTransport["chat"]
}

export interface AutomaticMemoryProvider {
  /** The injected, tool-less maintenance boundary. */
  readonly maintenance: MaintenanceProvider
  /** The primary chat model, also available to in-process capture/extraction. */
  readonly chat: PrimaryChatModel
  readonly label: string
  readonly egress: AutomaticMemoryEgress
}

/**
 * Resolved lifecycle configuration. The host resolves this once and passes the
 * same value to both MCP transports so their behavior cannot drift.
 */
export interface AutomaticMemoryRuntime {
  readonly enabled: boolean
  /** Present exactly when `enabled` is true. */
  readonly provider?: AutomaticMemoryProvider
  /** Test seam; production writes maintenance failures to stderr. */
  readonly report?: (message: string) => void
  /** Test seam; production watches the note root for cross-process writes. */
  readonly watch?: boolean
  /** Test seam; production records durable observed-revision receipts. */
  readonly revisionGate?: boolean
  /** Test seams for the cross-process run lease. */
  readonly lease?: {
    readonly staleMs?: number
    readonly pollMs?: number
  }
}

const configError = (message: string): Error =>
  new Error(`Automatic memory configuration: ${message}`)

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

const providerEndpoint = (
  raw: string,
): { readonly url: URL; readonly egress: AutomaticMemoryEgress } => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw configError(
      "SLIPMEM_CHAT_BASE_URL must be an explicit HTTPS URL, or HTTP only for a loopback host.",
    )
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configError(
      "SLIPMEM_CHAT_BASE_URL must use HTTPS, or HTTP only for a loopback host.",
    )
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw configError(
      "Plain HTTP chat providers are allowed only on a loopback host.",
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw configError(
      "SLIPMEM_CHAT_BASE_URL must not contain credentials; use SLIPMEM_CHAT_API_KEY.",
    )
  }
  if (url.search !== "" || url.hash !== "") {
    throw configError(
      "SLIPMEM_CHAT_BASE_URL must not contain a query string or fragment.",
    )
  }
  return {
    url,
    egress: isLoopbackHost(url.hostname) ? "local" : "remote",
  }
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

/**
 * Resolves the required primary chat model. Returns `undefined` only when no
 * primary/legacy chat variable is present at all; a partial configuration is a
 * startup error rather than a silent fallback to a heuristic or another model.
 */
export const resolvePrimaryChatModel = (
  env: Readonly<Record<string, string | undefined>>,
): PrimaryChatModel | undefined => {
  const provider = firstValue(
    env[PRIMARY_CHAT_ENV_NAMES.provider],
    env[PRIMARY_CHAT_ENV_NAMES.legacyProvider],
  )?.toLowerCase()
  const model = firstValue(
    env[PRIMARY_CHAT_ENV_NAMES.model],
    env[PRIMARY_CHAT_ENV_NAMES.legacyModel],
  )
  const baseUrl = firstValue(
    env[PRIMARY_CHAT_ENV_NAMES.baseUrl],
    env[PRIMARY_CHAT_ENV_NAMES.legacyBaseUrl],
  )
  const apiKey = firstValue(
    env[PRIMARY_CHAT_ENV_NAMES.apiKey],
    env[PRIMARY_CHAT_ENV_NAMES.legacyApiKey],
  )

  if (
    provider === undefined &&
    model === undefined &&
    baseUrl === undefined &&
    apiKey === undefined
  ) {
    return undefined
  }

  if (provider !== "openai-compatible") {
    throw configError(
      `SLIPMEM_CHAT_PROVIDER must be openai-compatible; received '${provider ?? ""}'. There is no default chat provider or automatic egress.`,
    )
  }
  if (model === undefined) {
    throw configError(
      "SLIPMEM_CHAT_PROVIDER=openai-compatible requires an explicit SLIPMEM_CHAT_MODEL.",
    )
  }
  if (baseUrl === undefined) {
    throw configError(
      "SLIPMEM_CHAT_PROVIDER=openai-compatible requires an explicit SLIPMEM_CHAT_BASE_URL. No provider URL is assumed.",
    )
  }

  const endpoint = providerEndpoint(baseUrl)
  const transport = makeOpenAiCompatibleTransport({
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  })

  return {
    model,
    label: `${model} at ${endpoint.url.origin}`,
    egress: endpoint.egress,
    chat: transport.chat,
  }
}

const providerFromChat = (chat: PrimaryChatModel): AutomaticMemoryProvider => ({
  maintenance: makePromptMaintenanceProvider((prompt) =>
    chat
      .chat({ messages: [{ role: "user", content: prompt }] })
      .pipe(Effect.map((result) => result.content)),
  ),
  chat,
  label: chat.label,
  egress: chat.egress,
})

/**
 * Resolves the serving memory lifecycle.
 *
 * Public MCP/web serve entrypoints call this unconditionally: a primary chat
 * model is required, and an absent/partial configuration is a startup error.
 * There is no production `SLIPMEM_AUTO_MEMORY=off` escape hatch that restores
 * the old no-model default. Ordinary filesystem CLI commands do not call this.
 * Tests and embedding hosts may still inject an explicit
 * `AutomaticMemoryRuntime` (including `{ enabled: false }`) through
 * `McpServerOptions`.
 */
export const resolveAutomaticMemoryRuntime = (
  env: Readonly<Record<string, string | undefined>>,
): AutomaticMemoryRuntime => {
  const chat = resolvePrimaryChatModel(env)
  if (chat === undefined) {
    throw configError(
      "serving requires a primary chat model. Set SLIPMEM_CHAT_PROVIDER=openai-compatible, SLIPMEM_CHAT_MODEL, and SLIPMEM_CHAT_BASE_URL (legacy SLIPMEM_MAINTENANCE_* names are also accepted).",
    )
  }

  return { enabled: true, provider: providerFromChat(chat) }
}

export interface RecallProviderRuntime {
  readonly evaluator?: PromptRecallEvaluator
  readonly notice?: string
  /** Which provider was selected; stable for host diagnostics. */
  readonly provider?: "jev" | "chat"
}

/**
 * Resolves prompt recall. Jev is optional and selected explicitly. With Jev
 * off, the same primary chat model used by automatic memory performs one
 * validated structured JSON decision per note. There is no runtime fallback
 * between providers: a configured provider's error is a per-note failure.
 */
export const resolveRecallProvider = (
  env: Readonly<Record<string, string | undefined>>,
): RecallProviderRuntime => {
  const raw = env.SLIPMEM_RECALL_PROVIDER?.trim().toLowerCase()
  if (raw === "jev") {
    const apiKey = env.TYPESAFE_API_KEY?.trim()
    if (apiKey === undefined || apiKey === "") {
      throw configError(
        "SLIPMEM_RECALL_PROVIDER=jev requires TYPESAFE_API_KEY.",
      )
    }
    const model = env.SLIPMEM_RECALL_JEV_MODEL?.trim()

    return {
      provider: "jev",
      evaluator: makeJevDecisionPromptRecallEvaluator({
        apiKey: Redacted.make(apiKey),
        model:
          model === undefined || model === ""
            ? DEFAULT_RECALL_JEV_MODEL
            : model,
      }),
      notice:
        "slipmem prompt recall: SLIPMEM_RECALL_PROVIDER=jev is configured. A recall_prompt tool call sends bounded permanent-note content to Jev/TypeSafe; no background recall runs.",
    }
  }
  if (raw !== undefined && raw !== "" && raw !== "off") {
    throw configError(
      `SLIPMEM_RECALL_PROVIDER must be jev or off; received '${env.SLIPMEM_RECALL_PROVIDER}'.`,
    )
  }

  const chat = resolvePrimaryChatModel(env)
  if (chat === undefined) {
    return {}
  }

  return {
    provider: "chat",
    evaluator: makeChatPromptRecallEvaluator({
      transport: { chat: chat.chat },
      model: chat.model,
    }),
    notice: `slipmem prompt recall: using the primary chat model ${chat.label} for one validated structured decision per permanent note. A recall_prompt call sends bounded note content to that provider; no background recall runs.`,
  }
}

/**
 * The startup disclosure for automatic memory. It deliberately names the
 * direct permanent-write path: the maintenance worker is not an MCP tool and
 * does not use the approval queue.
 */
export const formatAutomaticMemoryNotice = (
  runtime: AutomaticMemoryRuntime,
): string | undefined => {
  if (!runtime.enabled || runtime.provider === undefined) {
    return undefined
  }

  const egress =
    runtime.provider.egress === "remote"
      ? `WARNING: each run sends bounded fleeting/literature sources and candidate permanent notes to ${runtime.provider.label} over the network; that note content leaves this machine.`
      : `Each run sends bounded fleeting/literature sources and candidate permanent notes only to the configured local endpoint ${runtime.provider.label}.`

  return [
    "slipmem automatic memory: enabled; one recovery pass runs at startup and another runs when a fleeting or literature note revision is written. There is no periodic timer.",
    "Cross-process wakes use a scoped note-root watcher; unchanged revisions are not sent to the provider again.",
    egress,
    'Maintenance writes permanent notes directly with provenance source "maintenance"; it never deletes or reclassifies notes and does not use the MCP approval queue or SLIPMEM_MCP_WRITE_POLICY. MCP tool writes keep their existing approval policy.',
  ].join("\n")
}

const reportFailure =
  (report: (message: string) => void) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.void
    }
    const error = Cause.squash(cause)
    const message = error instanceof Error ? error.message : String(error)
    return Effect.sync(() =>
      report(`slipmem automatic memory: maintenance run failed: ${message}`),
    )
  }

const reportWatchFailure =
  (report: (message: string) => void) =>
  (cause: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      const message = cause instanceof Error ? cause.message : String(cause)
      report(
        `slipmem automatic memory: cross-process note watching is unavailable: ${message}. In-process raw writes still wake maintenance; other processes will be picked up by the next startup recovery pass.`,
      )
    })

/* -------------------------------------------------------------------------- */
/* Raw-write queue                                                            */
/* -------------------------------------------------------------------------- */

export interface RawWriteSignalShape {
  /** Enqueue one coalesced wake. Never blocks a note write. */
  readonly signal: Effect.Effect<void>
  /** Wait for one wake; callers drain coalesced wakes before running. */
  readonly awaitSignal: Effect.Effect<void>
  /** Drop already-queued wakes after one has been observed. */
  readonly drain: Effect.Effect<void>
  /** Synchronous variant for `fs.watch`/host callbacks. */
  readonly signalUnsafe: () => void
}

/**
 * Scoped cross-fiber wake queue. The queue has capacity one with a sliding
 * policy: a write never waits for maintenance, and a signal that arrives during
 * a run coalesces into one follow-up pass that observes the latest files.
 */
export class RawWriteSignal extends Context.Service<
  RawWriteSignal,
  RawWriteSignalShape
>()("@slipmem/mcp/RawWriteSignal") {}

export const makeRawWriteSignalLayer = (): Layer.Layer<RawWriteSignal> =>
  Layer.effect(
    RawWriteSignal,
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1)
      yield* Effect.addFinalizer(() =>
        Queue.shutdown(queue).pipe(Effect.map(() => undefined)),
      )
      return {
        signal: Queue.offer(queue, undefined).pipe(Effect.map(() => undefined)),
        awaitSignal: Queue.take(queue).pipe(Effect.map(() => undefined)),
        drain: Queue.clear(queue).pipe(Effect.map(() => undefined)),
        signalUnsafe: () => {
          Queue.offerUnsafe(queue, undefined)
        },
      }
    }),
  )

/** Only raw source notes wake consolidation; generated permanents do not. */
const isRawSourceType = (type: string): boolean =>
  type === "fleeting" || type === "literature"

/**
 * Wraps the shared repository so successful raw creates, updates, and deletes
 * enqueue a wake after the write is durable. All services and the worker keep
 * the same repository graph; the wrapper adds no lock and never wraps the
 * provider call.
 */
export const makeRawWriteRepositoryLayer = (): Layer.Layer<
  MarkdownNoteRepository,
  never,
  MarkdownNoteRepository | RawWriteSignal
> =>
  Layer.effect(
    MarkdownNoteRepository,
    Effect.gen(function* () {
      const base = yield* MarkdownNoteRepository
      const raw = yield* RawWriteSignal
      const wake = (type: string): Effect.Effect<void> =>
        isRawSourceType(type) ? raw.signal : Effect.void

      return {
        ...base,
        create: (input) =>
          base.create(input).pipe(
            Effect.tap((note) => wake(note.metadata.type)),
          ),
        update: (input) =>
          base.update(input).pipe(
            Effect.tap((note) => wake(note.metadata.type)),
          ),
        delete: (id, options) =>
          base.delete(id, options).pipe(
            Effect.tap((result) => wake(result.note.metadata.type)),
          ),
      }
    }),
  )

const isWatchableNoteFilename = (filename: string): boolean => {
  const normalized = filename.replaceAll("\\", "/")
  if (normalized.includes("/")) {
    // `.state/...` and nested directories are not note revisions.
    return false
  }
  if (normalized === "" || normalized.startsWith(".")) {
    // Atomic-write temporaries and the state directory itself.
    return false
  }
  if (!normalized.endsWith(".md") || normalized.endsWith(".tmp")) {
    return false
  }
  return true
}

/**
 * Scoped note-root watcher used as a cross-process wake hint. It filters state,
 * hidden, nested, non-Markdown, and temporary names. Missed or unsupported
 * events are covered by the startup recovery pass; a watcher startup failure is
 * reported, not swallowed.
 */
export const startNoteWatch = (options: {
  readonly root: string
  readonly signal: RawWriteSignalShape
  readonly report: (message: string) => void
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: (): FSWatcher =>
        watch(
          options.root,
          { persistent: true, recursive: false },
          (_event, filename) => {
            if (filename === null) {
              return
            }
            const name = Buffer.isBuffer(filename)
              ? filename.toString("utf8")
              : filename
            if (isWatchableNoteFilename(name)) {
              options.signal.signalUnsafe()
            }
          },
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.tap((watcher) =>
        Effect.sync(() =>
          watcher.on("error", (cause) => {
            options.report(
              `slipmem automatic memory: note watcher error: ${
                cause instanceof Error ? cause.message : String(cause)
              }. Startup recovery still covers missed writes.`,
            )
          }),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : reportWatchFailure(options.report)(Cause.squash(cause)).pipe(
              Effect.map(() => null),
            ),
      ),
    ),
    (watcher) =>
      watcher == null
        ? Effect.void
        : Effect.sync(() => {
            watcher.close()
          }),
  ).pipe(Effect.map(() => undefined))

/* -------------------------------------------------------------------------- */
/* Durable observed-revision receipts                                         */
/* -------------------------------------------------------------------------- */

export const REVISION_RECEIPT_FILENAME = "automatic-memory-revisions.json"

const receiptPath = (root: string): string =>
  join(root, STATE_DIRECTORY, REVISION_RECEIPT_FILENAME)

interface RevisionReceipts {
  readonly version: 1
  /**
   * Receipts written before bounded-batch draining recorded the whole inbox
   * snapshot, including revisions the worker never examined. That made a
   * backlog larger than one source limit permanently terminal. The marker
   * invalidates those older files so they get one conservative rescan.
   */
  readonly coverage: "examined"
  readonly revisions: Readonly<Record<string, string>>
  /** Managed permanent IDs and hashes, used to notice deletion/restore needs. */
  readonly managed: Readonly<Record<string, string>>
}

interface RevisionSnapshot {
  readonly sources: Readonly<Record<string, string>>
  readonly managed: Readonly<Record<string, string>>
}

const hashRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [id, hash] of Object.entries(value)) {
    if (typeof hash === "string") {
      result[id] = hash
    }
  }
  return result
}

const readReceipts = (root: string): Effect.Effect<RevisionReceipts | null> =>
  Effect.sync(() => {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath(root), "utf8")) as {
        readonly version?: unknown
        readonly coverage?: unknown
        readonly revisions?: unknown
        readonly managed?: unknown
      }
      if (parsed.version !== 1 || parsed.coverage !== "examined") {
        return null
      }
      const revisions = hashRecord(parsed.revisions)
      if (Object.keys(revisions).length === 0 && parsed.revisions !== undefined) {
        // An entirely malformed non-empty map is a first-run/rescan condition.
        if (
          typeof parsed.revisions !== "object" ||
          parsed.revisions === null ||
          Array.isArray(parsed.revisions)
        ) {
          return null
        }
      }
      return {
        version: 1,
        coverage: "examined",
        revisions,
        // Older receipts without this field cause one conservative rescan.
        managed: hashRecord(parsed.managed),
      }
    } catch {
      // Missing or malformed receipts are a safe first-run/rescan condition.
      return null
    }
  })

const ensureStateDirectory = (root: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      mkdirSync(join(root, STATE_DIRECTORY), { recursive: true, mode: 0o700 })
    },
    catch: (cause) =>
      new Error(
        `Could not create ${STATE_DIRECTORY}/ for automatic-memory receipts: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
  })

const orderedRecord = (
  record: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  )

const writeReceipts = (
  root: string,
  snapshot: RevisionSnapshot,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* ensureStateDirectory(root)
    const body = `${JSON.stringify(
      {
        version: 1,
        coverage: "examined",
        revisions: orderedRecord(snapshot.sources),
        managed: orderedRecord(snapshot.managed),
      },
      null,
      2,
    )}\n`
    yield* atomicWriteFile(receiptPath(root), body, {
      overwrite: true,
      mode: 0o600,
    }).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `Could not record automatic-memory revision receipts: ${error.message}`,
          ),
      ),
    )
  })

const revisionSnapshot = (
  repository: Pick<MarkdownNoteRepositoryShape, "scan">,
): Effect.Effect<RevisionSnapshot, MarkdownError> =>
  repository.scan().pipe(
    Effect.map((scan) => {
      const sources: Record<string, string> = {}
      const managed: Record<string, string> = {}
      for (const note of scan.notes) {
        if (isRawSourceType(note.metadata.type)) {
          sources[note.id] = note.contentHash
        }
        if (managedPermanentMetadata(note) !== null) {
          managed[note.id] = note.contentHash
        }
      }
      return { sources, managed }
    }),
  )

const sameRevisions = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftIds = Object.keys(left)
  if (leftIds.length !== Object.keys(right).length) {
    return false
  }
  return leftIds.every((id) => left[id] === right[id])
}

const sameSnapshot = (
  left: RevisionSnapshot,
  right: RevisionSnapshot,
): boolean =>
  sameRevisions(left.sources, right.sources) &&
  sameRevisions(left.managed, right.managed)

/** Every current raw revision has an identical examined receipt. */
const coversSources = (
  receipts: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(current).every(([id, hash]) => receipts[id] === hash)

const mergeRevisions = (
  base: Readonly<Record<string, string>>,
  added: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const next: Record<string, string> = { ...base }
  for (const [id, hash] of Object.entries(added)) {
    next[id] = hash
  }
  return next
}

/**
 * Drop receipts for source notes that no longer exist. Coverage only requires
 * every current revision to be recorded; pruning keeps the file bounded.
 */
const retainCurrentRevisions = (
  revisions: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const next: Record<string, string> = {}
  for (const [id, hash] of Object.entries(revisions)) {
    if (current[id] !== undefined) {
      next[id] = hash
    }
  }
  return next
}

/**
 * Safety bound for one wake. Each batch is already bounded by the worker's
 * source limit; this only stops a provider that keeps making progress while
 * raw notes are edited continuously from monopolizing the fiber forever.
 * Unexamined revisions stay unreceipted, so a later wake resumes the drain.
 */
const MAX_DRAIN_BATCHES = 1_000

/** Score the exact revisions the worker offered, not the whole inbox. */
const examinedRevisions = (
  result: MaintenanceRunResult,
  before: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const examined: Record<string, string> = {}
  if (result.examinedSources !== undefined) {
    for (const source of result.examinedSources) {
      examined[source.id] = source.contentHash
    }
    return examined
  }
  // Compatibility with a worker that predates `examinedSources`: its selected
  // IDs are the examined set. The pre-run hash is conservative; if the source
  // changed during the call, the receipt will not match the current revision
  // and that revision stays pending.
  for (const id of result.selectedSourceIds) {
    const hash = before[id]
    if (hash !== undefined) {
      examined[id] = hash
    }
  }
  return examined
}

/* -------------------------------------------------------------------------- */
/* Cross-process run lease                                                    */
/* -------------------------------------------------------------------------- */

export const RUN_LEASE_FILENAME = "automatic-memory.lease"
export const DEFAULT_RUN_LEASE_STALE_MS = 10 * 60_000
export const DEFAULT_RUN_LEASE_POLL_MS = 250

interface LeaseRecord {
  readonly pid: number
  readonly token: string
  readonly createdAt: string
}

interface HeldLease {
  readonly path: string
  readonly token: string
  readonly heartbeat: ReturnType<typeof setInterval>
}

const leasePath = (root: string): string =>
  join(root, STATE_DIRECTORY, RUN_LEASE_FILENAME)

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EPERM"
    )
  }
}

const readLease = (path: string): LeaseRecord | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>
    return typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.createdAt === "string"
      ? {
          pid: parsed.pid,
          token: parsed.token,
          createdAt: parsed.createdAt,
        }
      : null
  } catch {
    return null
  }
}

const leaseIsStale = (path: string, staleMs: number): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = lstatSync(path).mtimeMs
  } catch {
    return true
  }
  const record = readLease(path)
  if (record === null) {
    // A fresh malformed file may be mid-write; only age recovers it.
    return Date.now() - mtimeMs > staleMs
  }
  if (!isProcessAlive(record.pid)) {
    return true
  }
  // A live owner with a lapsed heartbeat is treated as stale only after the
  // bounded lease age. The owner refreshes the mtime while the provider runs.
  return Date.now() - mtimeMs > staleMs
}

const tryCreateLease = (path: string, record: LeaseRecord): boolean => {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeSync(descriptor, JSON.stringify(record))
    return true
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "EEXIST"
    ) {
      return false
    }
    throw cause
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

const acquireRunLease = (options: {
  readonly root: string
  readonly staleMs: number
  readonly pollMs: number
}): Effect.Effect<HeldLease, Error> =>
  Effect.gen(function* () {
    yield* ensureStateDirectory(options.root)
    const path = leasePath(options.root)
    const token = randomUUID()
    const record: LeaseRecord = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    }

    for (;;) {
      const created = yield* Effect.try({
        try: () => tryCreateLease(path, record),
        catch: (cause) =>
          new Error(
            `Could not acquire the automatic-memory run lease: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          ),
      })
      if (created) {
        const heartbeat = setInterval(() => {
          const current = readLease(path)
          if (current === null || current.token !== token) {
            clearInterval(heartbeat)
            return
          }
          try {
            const now = new Date()
            utimesSync(path, now, now)
          } catch {
            // The next acquire/release observes the real condition.
          }
        }, Math.max(25, Math.floor(options.staleMs / 3)))
        heartbeat.unref?.()
        return { path, token, heartbeat }
      }

      const stale = yield* Effect.sync(() =>
        leaseIsStale(path, options.staleMs),
      )
      if (stale) {
        yield* Effect.sync(() => {
          try {
            unlinkSync(path)
          } catch {
            // Another waiter may have removed it first.
          }
        })
        continue
      }

      // Waiting never drops the wake: once the holder releases, this pass runs
      // and re-checks durable receipts so a duplicate pass becomes a no-op.
      yield* Effect.sleep(Duration.millis(options.pollMs))
    }
  })

const releaseRunLease = (lease: HeldLease): Effect.Effect<void> =>
  Effect.sync(() => {
    clearInterval(lease.heartbeat)
    const current = readLease(lease.path)
    if (current !== null && current.token !== lease.token) {
      return
    }
    try {
      unlinkSync(lease.path)
    } catch {
      // Already released.
    }
  })

/**
 * Serializes consolidation across processes without holding the repository
 * mutation lock. The provider call runs under this lease only; each repository
 * write still takes the authoritative mutation lock for its own critical
 * section.
 */
export const withRunLease = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly staleMs?: number
    readonly pollMs?: number
  } = {},
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    acquireRunLease({
      root,
      staleMs: options.staleMs ?? DEFAULT_RUN_LEASE_STALE_MS,
      pollMs: options.pollMs ?? DEFAULT_RUN_LEASE_POLL_MS,
    }),
    () => effect,
    releaseRunLease,
  )

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Starts the event-driven maintenance fiber in the layer's scope.
 *
 * Startup enqueues one recovery wake. In-process raw writes enqueue through the
 * wrapped repository; cross-process raw writes are observed with a scoped
 * directory watcher. Runs are sequential and serialized across processes with a
 * separate run lease. One wake drains bounded worker batches until every current
 * raw revision has an examined receipt or a batch makes no progress. Durable
 * receipts record only the revisions the worker actually offered, so a backlog
 * larger than one source limit stays pending across batches and restarts.
 */
export const makeAutomaticMemoryLayer = (
  runtime: AutomaticMemoryRuntime,
): Layer.Layer<
  never,
  never,
  PermanentMaintenanceWorker | RawWriteSignal | MarkdownNoteRepository
> =>
  runtime.enabled && runtime.provider !== undefined
    ? Layer.effectDiscard(
        Effect.gen(function* () {
          const worker = yield* PermanentMaintenanceWorker
          const raw = yield* RawWriteSignal
          const repository = yield* MarkdownNoteRepository
          const report =
            runtime.report ??
            ((message: string) => {
              process.stderr.write(`${message}\n`)
            })

          const pass = Effect.gen(function* () {
            if (runtime.revisionGate === false) {
              yield* worker.run()
              return
            }

            const receipts = yield* readReceipts(worker.root)
            let observed: RevisionSnapshot =
              receipts === null
                ? { sources: {}, managed: {} }
                : {
                    sources: receipts.revisions,
                    managed: receipts.managed,
                  }
            let firstBatch = true

            for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
              const current = yield* revisionSnapshot(repository)
              if (firstBatch) {
                firstBatch = false
                if (
                  receipts !== null &&
                  coversSources(observed.sources, current.sources) &&
                  sameRevisions(observed.managed, current.managed)
                ) {
                  return
                }
              }

              const result = yield* worker.run()
              const after = yield* revisionSnapshot(repository)
              const previous = observed

              // Never receipt a pass that has to be retried. A refused
              // repository write, or a run that could not offer pending
              // sources, must remain visible to the next wake.
              const retryableWrite = result.skips.some(
                (skip) => skip.reason === "repository write was refused",
              )
              const pendingWithoutProvider =
                !result.providerCalled && result.pendingSourceCount > 0

              if (!retryableWrite && !pendingWithoutProvider) {
                const sources =
                  result.pendingSourceCount === 0
                    ? // An explicit no-op scanned the whole inbox and found
                      // every raw revision already consumed by a permanent.
                      current.sources
                    : mergeRevisions(
                        observed.sources,
                        examinedRevisions(result, current.sources),
                      )
                observed = {
                  sources: retainCurrentRevisions(sources, after.sources),
                  managed: after.managed,
                }
                if (batch === 0 || !sameSnapshot(observed, previous)) {
                  yield* writeReceipts(worker.root, observed)
                }
              }

              if (
                coversSources(observed.sources, after.sources) &&
                sameRevisions(observed.managed, after.managed)
              ) {
                return
              }
              if (retryableWrite || pendingWithoutProvider) {
                return
              }
              if (sameSnapshot(observed, previous)) {
                // No new revision was examined or settled. Do not spin on a
                // cooled or unselectable backlog; a later write wakes it.
                return
              }
            }
          }).pipe(
            Effect.catchCause(reportFailure(report)),
          )

          const consume = Effect.gen(function* () {
            yield* raw.awaitSignal
            yield* raw.drain
            yield* withRunLease(worker.root, pass, runtime.lease).pipe(
              Effect.catchCause(reportFailure(report)),
            )
          }).pipe(Effect.forever, Effect.forkScoped)

          if (runtime.watch !== false) {
            yield* startNoteWatch({
              root: worker.root,
              signal: raw,
              report,
            })
          }

          // Startup recovery. The receipt gate makes this cheap when the inbox
          // has not changed since the previous process.
          yield* raw.signal
          yield* consume
        }),
      )
    : Layer.empty
