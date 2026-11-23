import type { McpServerOptions } from "@slipmem/mcp"
import { makeServingRuntime } from "@slipmem/mcp/runtime"
import { Cause, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { MarkdownApiRoutes } from "./api"
import type { AppExtraRequirements } from "./app"
import { makeMcpHttpRoutes } from "./mcp"

export interface ServingAppOptions<Extra = never, ExtraError = never>
  extends Omit<McpServerOptions, "root"> {
  /**
   * Additional routes built over the same shared graph. Do not pass
   * `makeMcpHttp` here: this layer already mounts `/mcp` over the shared graph.
   */
  readonly extraRoutes?: Layer.Layer<Extra, ExtraError, AppExtraRequirements>
}

/**
 * Composes the canonical JSON API and the HTTP MCP endpoint over exactly one
 * serving graph.
 *
 * This is the integration point that replaces a host-owned Markdown layer plus
 * a separate MCP service composition. Both surfaces are provided by
 * `runtime.services`, so they observe the same repository instance, the same
 * disposable index, the same approval proposal store, and (when enabled) the
 * same consolidation worker and raw-write signal.
 *
 * The returned layer still requires `HttpRouter.HttpRouter`; pass it to
 * `HttpRouter.toWebHandler` exactly like `makeAppLayer`.
 */
export const makeServingAppLayer = <Extra = never, ExtraError = never>(
  noteRoot: string,
  options: ServingAppOptions<Extra, ExtraError> = {},
) => {
  const { extraRoutes, ...mcpOptions } = options
  const runtime = makeServingRuntime({ root: noteRoot, ...mcpOptions })

  const mcpRoutes = makeMcpHttpRoutes(runtime.registrations)

  const routes =
    extraRoutes === undefined
      ? Layer.merge(MarkdownApiRoutes, mcpRoutes)
      : Layer.merge(MarkdownApiRoutes, Layer.merge(mcpRoutes, extraRoutes))

  return {
    runtime,
    layer: routes.pipe(Layer.provide(runtime.services)),
  }
}

export interface ServingApiHandlerOptions<Extra = never, ExtraError = never>
  extends ServingAppOptions<Extra, ExtraError> {
  readonly disableLogger?: boolean
}

const makeReadySignal = () => {
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // The build starts immediately, so a host that only calls handler/dispose
  // must not get an unhandled rejection. A caller can still await `ready` and
  // observe the same failure.
  ready.catch(() => undefined)
  return { ready, resolveReady, rejectReady }
}

/**
 * Builds a Web `fetch` handler for the JSON API and `/mcp` over one serving
 * graph. This mirrors `makeApiHandler`'s readiness and disposal contract.
 */
export const makeServingApiHandler = <Extra = never, ExtraError = never>(
  noteRoot: string,
  options: ServingApiHandlerOptions<Extra, ExtraError> = {},
) => {
  const { disableLogger, ...appOptions } = options
  const { ready, resolveReady, rejectReady } = makeReadySignal()
  const { runtime, layer } = makeServingAppLayer(noteRoot, appOptions)
  const appLayer = layer.pipe(
    Layer.tap(() =>
      Effect.sync(() => {
        resolveReady()
      }),
    ),
    Layer.tapCause((cause) =>
      Effect.sync(() => {
        rejectReady(Cause.squash(cause))
      }),
    ),
  )
  const app = HttpRouter.toWebHandler(appLayer, { disableLogger })

  return {
    runtime,
    handler: (request: Request) => app.handler(request, Context.empty()),
    dispose: app.dispose,
    ready,
  }
}
