import { Context, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { NoteRoutes } from "./api"
import { makeDatabaseLayer } from "./database"
import { McpHttp } from "./mcp"

/**
 * Combines the JSON API and the streamable HTTP MCP endpoint over one SQLite
 * database. Both transports share the same note services.
 */
export const makeAppLayer = (databasePath: string) =>
  Layer.mergeAll(NoteRoutes, McpHttp).pipe(
    Layer.provide(makeDatabaseLayer(databasePath)),
  )

/**
 * Builds a Web `fetch` handler for the JSON API and MCP endpoint. Build it
 * once at module scope and call `dispose` when the host shuts down.
 */
export const makeApiHandler = (
  databasePath: string,
  options?: { readonly disableLogger?: boolean },
) => {
  const app = HttpRouter.toWebHandler(makeAppLayer(databasePath), {
    disableLogger: options?.disableLogger,
  })

  return {
    handler: (request: Request) => app.handler(request, Context.empty()),
    dispose: app.dispose,
  }
}
