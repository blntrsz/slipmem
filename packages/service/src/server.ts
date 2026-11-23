import {
  formatAutomaticMemoryNotice,
  makeApiHandler,
  makeMcpHttp,
  resolveAutomaticMemoryRuntime,
  resolveNoteRootPath,
  resolveRecallProvider,
} from "@slipmem/server"

import { ServiceError } from "./errors"
import { serviceHealthResponse } from "./health"
import {
  acquireServiceOwner,
  canonicalServiceRoot,
  ensureServiceDirectory,
  processStartIdentity,
  removeRegistrationOwnedBy,
  serviceUrl,
  writeServiceState,
  type ServiceOwnerHandle,
  type ServiceState,
} from "./state"

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") {
    return 0
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServiceError(
      "invalid-port",
      `SLIPMEM_SERVICE_PORT must be an integer between 0 and 65535, got ${raw}.`,
    )
  }
  return port
}

type ApiHandler = ReturnType<typeof makeApiHandler>

const DISPOSE_TIMEOUT_MS = 5_000

let server: ReturnType<typeof Bun.serve> | undefined
let api: ApiHandler | undefined
let owner: ServiceOwnerHandle | undefined
let instanceId: string | undefined
let shuttingDown = false
let readinessError: string | undefined

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const settle = async (
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, milliseconds)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * `makeApiHandler` builds its layer immediately and exposes `ready` for the
 * build outcome, so the service can wait for the real application graph rather
 * than binding a listener and declaring itself healthy optimistically.
 */
const awaitApplicationReadiness = async (
  handler: ApiHandler,
): Promise<void> => {
  await handler.ready
}

const exitAfterReadinessFailure = async (message: string): Promise<never> => {
  readinessError = message
  process.stderr.write(`slipmem service readiness: ${message}\n`)
  try {
    server?.stop(true)
  } catch {
    // The listener may already be closed.
  }
  if (api !== undefined) {
    await settle(api.dispose(), DISPOSE_TIMEOUT_MS)
  }
  cleanupRegistration()
  process.exit(1)
}

const cleanupRegistration = (): void => {
  if (instanceId !== undefined) {
    const owned = instanceId
    removeRegistrationOwnedBy(
      canonicalRootForCleanup,
      (record) => record.instanceId === owned,
    )
  }
  owner?.release()
}

let canonicalRootForCleanup = ""

const shutdown = async (code: number): Promise<void> => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  try {
    server?.stop(true)
  } catch {
    // The server may already be closed.
  }
  if (api !== undefined) {
    // A hung layer disposal must not keep a signal shutdown alive forever.
    await settle(api.dispose(), DISPOSE_TIMEOUT_MS)
  }
  cleanupRegistration()
  process.exit(code)
}

const fail = (cause: unknown): never => {
  process.stderr.write(
    `slipmem service startup: ${
      cause instanceof Error ? cause.message : String(cause)
    }\n`,
  )
  cleanupRegistration()
  process.exit(1)
}

const main = async (): Promise<void> => {
  const root = canonicalServiceRoot(resolveNoteRootPath())
  canonicalRootForCleanup = root
  const port = parsePort(process.env.SLIPMEM_SERVICE_PORT)

  // Model resolution is the same serving contract as stdio and web. It
  // validates explicit operator configuration and constructs a tool-less
  // transport; no request is made until the worker's first bounded pass.
  const automaticMemory = resolveAutomaticMemoryRuntime(process.env)
  const recallProvider = resolveRecallProvider(process.env)

  const notice = formatAutomaticMemoryNotice(automaticMemory)
  if (notice !== undefined) {
    process.stderr.write(`${notice}\n`)
  }
  if (recallProvider.notice !== undefined) {
    process.stderr.write(`${recallProvider.notice}\n`)
  }

  ensureServiceDirectory(root)
  owner = acquireServiceOwner(root)
  instanceId = owner.record.instanceId

  // This is the same canonical API and HTTP MCP composition as the web entry.
  // It is not a second implementation: one service process owns the one scoped
  // maintenance worker for this root, independent of any connected client.
  const extraRoutes = makeMcpHttp({
    root,
    automaticMemory,
    ...(recallProvider.evaluator === undefined
      ? {}
      : { recallEvaluator: recallProvider.evaluator }),
  })
  api = makeApiHandler(root, { extraRoutes })

  // Bind before readiness so a concurrent health probe sees an honest
  // "not-ready" instead of guessing from a connection refused. Readiness (and
  // the ready registration) still waits for the application layer to build.
  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/service/health") {
        return serviceHealthResponse(currentState, readinessError)
      }
      return api!.handler(request)
    },
  })
  server = bound
  const boundPort = bound.port
  if (boundPort === undefined) {
    throw new ServiceError(
      "io",
      "The loopback service did not report a bound port.",
    )
  }

  // The ready registration and the "listening" message are written only after
  // the layered application is actually usable. A broken layer exits here with
  // an actionable readiness error instead of advertising a healthy service.
  try {
    await awaitApplicationReadiness(api)
  } catch (cause) {
    await exitAfterReadinessFailure(
      `The application layer was not ready: ${messageOf(cause)}`,
    )
  }

  const state: ServiceState = {
    version: 1,
    root,
    pid: process.pid,
    identity: processStartIdentity(process.pid),
    instanceId: owner.record.instanceId,
    url: serviceUrl(boundPort),
    port: boundPort,
    startedAt: owner.record.startedAt,
  }
  currentState = state
  writeServiceState(root, state)

  process.stderr.write(
    `slipmem service listening on ${state.url} for ${root}\n`,
  )
}

let currentState: ServiceState | undefined

process.once("SIGINT", () => {
  void shutdown(0)
})
process.once("SIGTERM", () => {
  void shutdown(0)
})

try {
  await main()
} catch (cause) {
  fail(cause)
}
