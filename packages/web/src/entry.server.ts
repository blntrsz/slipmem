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

type ApiHandler = ReturnType<typeof makeApiHandler>

// Vite's development SSR runner re-evaluates this module after edits without
// disposing its previous instance. Keep the current handler on `globalThis` so
// the new instance can close the old search index before replacing it, and
// close the current handler on shutdown.
type ServerGlobals = typeof globalThis & {
  __slipmemApiHandler?: ApiHandler
  __slipmemShutdownRegistered?: boolean
  __slipmemNoticesPrinted?: boolean
}

const serverGlobals = globalThis as ServerGlobals

const disposeApi = (): Promise<void> => {
  const handler = serverGlobals.__slipmemApiHandler
  serverGlobals.__slipmemApiHandler = undefined
  return handler?.dispose() ?? Promise.resolve()
}

const previousApi = serverGlobals.__slipmemApiHandler
if (previousApi !== undefined) {
  void previousApi.dispose()
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

if (serverGlobals.__slipmemShutdownRegistered !== true) {
  serverGlobals.__slipmemShutdownRegistered = true

  const shutdown = () => {
    void disposeApi().finally(() => process.exit(0))
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
 * One Web fetch handler serves the Foldkit page and the JSON API. The dev host
 * and the built server entry both reach this function, so there is no separate
 * API process to start and no browser-only source of truth.
 */
export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
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
  )
