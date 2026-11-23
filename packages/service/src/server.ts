import {
  formatAutomaticMemoryNotice,
  makeApiHandler,
  makeMcpHttp,
  resolveAutomaticMemoryRuntime,
  resolveNoteRootPath,
  resolveRecallProvider,
} from "@slipmem/server"

import { ServiceError } from "./errors"
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

let server: ReturnType<typeof Bun.serve> | undefined
let api: ReturnType<typeof makeApiHandler> | undefined
let owner: ServiceOwnerHandle | undefined
let instanceId: string | undefined
let shuttingDown = false

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
    server?.stop()
  } catch {
    // The server may already be closed.
  }
  try {
    await api?.dispose()
  } catch {
    // Cleanup must not turn a signal into a crash report.
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

  const bound = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/service/health") {
        const state = currentState
        if (state === undefined) {
          return Response.json(
            { ok: false, service: "slipmem", error: "not-ready" },
            { status: 503, headers: { "cache-control": "no-store" } },
          )
        }
        return Response.json(
          {
            ok: true,
            service: "slipmem",
            root: state.root,
            pid: state.pid,
            instanceId: state.instanceId,
            startedAt: state.startedAt,
            url: state.url,
          },
          { headers: { "cache-control": "no-store" } },
        )
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
