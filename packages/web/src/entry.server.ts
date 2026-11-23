import { Effect, Layer } from "effect"
import { Server } from "foldkit/experimental"

import {
  formatAutomaticMemoryNotice,
  formatGitIngressNotice,
  makeApiHandler,
  makeGitIngressLayer,
  makeMcpHttp,
  resolveAutomaticMemoryRuntime,
  resolveGitIngressConfig,
  resolveNoteRootPath,
  resolveRecallProvider,
} from "@slipmem/server"

import { init, view } from "./main"

export const renderDocument = Server.renderDocument

const DISPOSE_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = DISPOSE_TIMEOUT_MS + 1_000

// Vite's development SSR runner re-evaluates this module after edits without
// disposing its previous instance. Keep the current handler on `globalThis` so
// the new instance can close the old search index before replacing it, and
// close the current handler on shutdown.
type ServerGlobals = typeof globalThis & {
  __slipmemApiHandler?: ApiHandler
  __slipmemShutdownRegistered?: boolean
  __slipmemNoticesPrinted?: boolean
}

type ApiHandler = ReturnType<typeof makeApiHandler>

const serverGlobals = globalThis as ServerGlobals

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * A cleanup promise must never become an unhandled rejection and must never
 * block a reload or a signal shutdown indefinitely. Log the failure and bound
 * the wait.
 */
const settle = async (
  operation: Promise<unknown>,
  milliseconds: number,
  label: string,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  try {
    await Promise.race([
      operation.then(
        () => {
          settled = true
        },
        (cause) => {
          settled = true
          console.error(`slipmem web ${label}: ${messageOf(cause)}`)
        },
      ),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, milliseconds)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    return settled
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

const disposeHandler = (handler: ApiHandler): Promise<boolean> => {
  let disposal: Promise<unknown>
  try {
    disposal = handler.dispose()
  } catch (cause) {
    console.error(`slipmem web dispose: ${messageOf(cause)}`)
    return Promise.resolve(true)
  }
  return settle(disposal, DISPOSE_TIMEOUT_MS, "dispose")
}

const disposeApi = (): Promise<boolean> => {
  const handler = serverGlobals.__slipmemApiHandler
  serverGlobals.__slipmemApiHandler = undefined
  return handler === undefined ? Promise.resolve(true) : disposeHandler(handler)
}

// Finish disposing the previous module instance before this one opens the same
// search index. Awaiting (rather than fire-and-forget) keeps the ordering
// honest and lets a rejected disposal be reported instead of escaping.
const previousApi = serverGlobals.__slipmemApiHandler
if (previousApi !== undefined) {
  serverGlobals.__slipmemApiHandler = undefined
  await disposeHandler(previousApi)
}

// Markdown is the only source of truth. A missing `.slipmem/` is reported with
// the `slipmem init` guidance instead of silently creating a repository or
// falling back to the retired SQLite note tables. The HTTP MCP endpoint shares
// the same note root and registration layer as the stdio server.
//
// Provider resolution happens before the handler is built so an invalid or
// incomplete automatic-memory/chat configuration fails startup exactly like the
// stdio entry point. A programmatic host can still inject a fixture by calling
// `makeMcpHttp`/`makeAutomaticMemoryLayer` directly instead of using this
// environment-driven entry.
const resolveStartup = () => {
  try {
    return {
      noteRoot: resolveNoteRootPath(),
      automaticMemory: resolveAutomaticMemoryRuntime(process.env),
      recallProvider: resolveRecallProvider(process.env),
      gitIngress: resolveGitIngressConfig(process.env),
    }
  } catch (error) {
    console.error(
      `slipmem web startup: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

const { noteRoot, automaticMemory, recallProvider, gitIngress } = resolveStartup()

if (serverGlobals.__slipmemNoticesPrinted !== true) {
  serverGlobals.__slipmemNoticesPrinted = true
  const automaticNotice = formatAutomaticMemoryNotice(automaticMemory)
  if (automaticNotice !== undefined) {
    console.error(automaticNotice)
  }
  if (recallProvider.notice !== undefined) {
    console.error(recallProvider.notice)
  }
  const ingressNotice = formatGitIngressNotice(
    gitIngress,
    automaticMemory.enabled,
  )
  if (ingressNotice !== undefined) {
    console.error(ingressNotice)
  }
}

const mcpRoutes = makeMcpHttp({
  root: noteRoot,
  automaticMemory,
  ...(recallProvider.evaluator === undefined
    ? {}
    : { recallEvaluator: recallProvider.evaluator }),
})

// The Git ingress is absent unless it resolved an explicit token, trusted
// worktree, command, and capture model. It is a separate surface; it never
// widens the unauthenticated JSON API or the MCP endpoint.
const extraRoutes =
  gitIngress.enabled === true
    ? Layer.merge(
        mcpRoutes,
        makeGitIngressLayer({
          config: gitIngress,
          noteRoot,
          maintenanceEnabled: automaticMemory.enabled,
        }),
      )
    : mcpRoutes

const api = makeApiHandler(noteRoot, { extraRoutes })
serverGlobals.__slipmemApiHandler = api

// The handler exposes the application-layer build outcome. Awaiting it turns a
// failed layer into one structured 503 instead of a burst of rejected requests.
let readinessFailure: string | undefined
const apiReadiness: Promise<void> = api.ready.then(
  () => undefined,
  (cause) => {
    readinessFailure = messageOf(cause)
    console.error(`slipmem web readiness: ${readinessFailure}`)
  },
)

if (serverGlobals.__slipmemShutdownRegistered !== true) {
  serverGlobals.__slipmemShutdownRegistered = true

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    // Disposal is normally quick, but a stuck resource must not make a signal
    // hang forever. Exit non-zero if the bound elapses; a clean disposal exits
    // zero.
    const timer = setTimeout(() => {
      console.error(
        `slipmem web shutdown: disposal did not settle within ${SHUTDOWN_TIMEOUT_MS}ms`,
      )
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()

    void disposeApi().then(
      (settled) => {
        clearTimeout(timer)
        process.exit(settled ? 0 : 1)
      },
      (cause) => {
        clearTimeout(timer)
        console.error(`slipmem web shutdown: ${messageOf(cause)}`)
        process.exit(1)
      },
    )
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

const isApiRequest = (pathname: string): boolean =>
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  pathname === "/mcp" ||
  pathname.startsWith("/mcp/")

/**
 * Mirrors the API error envelope emitted by the server (`{ error, code }`, see
 * `packages/server/src/api.ts` `errorResponse`) so the web client's `ensureOk`
 * surfaces the descriptive `error` message instead of the machine `code`.
 */
const structuredResponse = (
  status: number,
  code: string,
  message: string,
): Response =>
  new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })

const abortedResponse = (): Response =>
  structuredResponse(
    499,
    "request-aborted",
    "The client closed the request before it completed.",
  )

/**
 * One Web fetch handler serves the Foldkit page and the JSON API. The dev host
 * and the built server entry both reach this function, so there is no separate
 * API process to start and no browser-only source of truth.
 *
 * Failures become a structured response instead of a rejected module request:
 * readiness failures are 503, an aborted request is 499, and any render or
 * handler failure is a no-store 500. The detail stays in the server log so an
 * internal path or message is not echoed to the browser.
 */
export const renderPage = async (
  request: Request,
): Promise<Server.EntryResult> => {
  if (request.signal.aborted) {
    return Server.Responded(abortedResponse())
  }

  await apiReadiness
  if (request.signal.aborted) {
    return Server.Responded(abortedResponse())
  }
  if (readinessFailure !== undefined) {
    return Server.Responded(
      structuredResponse(503, "not-ready", "The slipmem application layer is not ready."),
    )
  }

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(request.url)

        if (isApiRequest(url.pathname)) {
          const response = yield* Effect.promise(() => api.handler(request))
          return Server.Responded(response)
        }

        const renderedApplication = yield* Server.renderToString(
          { routing: {}, init, view },
          { url: request.url },
        )

        return Server.Rendered(renderedApplication, {
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "same-origin",
          },
        })
      }),
      { signal: request.signal },
    )

    return request.signal.aborted
      ? Server.Responded(abortedResponse())
      : result
  } catch (cause) {
    if (request.signal.aborted) {
      return Server.Responded(abortedResponse())
    }
    console.error(`slipmem web render: ${messageOf(cause)}`)
    return Server.Responded(
      structuredResponse(500, "render-failed", "The page could not be rendered."),
    )
  }
}
