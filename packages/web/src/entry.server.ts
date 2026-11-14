import { Effect } from "effect"
import { Server } from "foldkit/experimental"

import { makeApiHandler, resolveDatabasePath } from "@slipmem/server"

import { init, view } from "./main"

export const renderDocument = Server.renderDocument

type ApiHandler = ReturnType<typeof makeApiHandler>

// Vite's development SSR runner re-evaluates this module after edits without
// disposing its previous instance. Keep the current handler on `globalThis` so
// the new instance can close the old SQLite connection before replacing it,
// and close the current handler on shutdown.
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

const api = makeApiHandler(resolveDatabasePath())
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
 * One Web fetch handler serves the Foldkit page, the JSON API, and the
 * streamable HTTP MCP endpoint. The dev host and the built server entry both
 * reach this function, so there is no separate API process to start.
 */
export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url)

      if (isApiRequest(url.pathname)) {
        const response = yield* Effect.promise(() => api.handler(request))
        return Server.Responded(response)
      }

      const renderedApplication = yield* Server.renderToString({ init, view })

      return Server.Rendered(renderedApplication, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      })
    }),
  )
