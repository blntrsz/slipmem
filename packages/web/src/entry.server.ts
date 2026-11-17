import { Effect } from "effect"
import { Server } from "foldkit/experimental"

import { makeApiHandler, makeMcpHttp, resolveNoteRootPath } from "@slipmem/server"

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
const noteRoot = resolveNoteRootPath()
const api = makeApiHandler(noteRoot, {
  extraRoutes: makeMcpHttp({ root: noteRoot }),
})
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
