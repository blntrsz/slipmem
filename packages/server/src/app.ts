import { Context, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { MarkdownApiRoutes } from "./api"
import { makeMarkdownLayer } from "./markdown"

export interface AppLayerOptions {
  /** Exact cache directory for the disposable index. Defaults to XDG cache. */
  readonly cacheDir?: string
  /** Injectable clock for deterministic note filenames in tests. */
  readonly now?: () => number
  /**
   * Additional routes supplied by another surface. They are built with the
   * same Markdown repository and search index as the JSON API, so an HTTP MCP
   * endpoint added here sees exactly the same files.
   */
  readonly extraRoutes?: Layer.Layer<never, never, never>
}

/**
 * Combines the canonical JSON API with any caller-supplied routes over one
 * Markdown note root and one disposable index.
 *
 * There is no SQLite note database in this layer. If the repository is not
 * initialized, building the layer fails and the process exits with the
 * `slipmem init` guidance from the core root resolver.
 */
export const makeAppLayer = (
  noteRoot: string,
  options: AppLayerOptions = {},
) => {
  const routes =
    options.extraRoutes === undefined
      ? MarkdownApiRoutes
      : Layer.merge(MarkdownApiRoutes, options.extraRoutes)

  return routes.pipe(
    Layer.provide(
      makeMarkdownLayer({
        root: noteRoot,
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    ),
  )
}

export interface ApiHandlerOptions extends AppLayerOptions {
  readonly disableLogger?: boolean
}

/**
 * Builds a Web `fetch` handler for the Markdown-backed JSON API. Build it once
 * at module scope and call `dispose` when the host shuts down.
 */
export const makeApiHandler = (
  noteRoot: string,
  options: ApiHandlerOptions = {},
) => {
  const app = HttpRouter.toWebHandler(makeAppLayer(noteRoot, options), {
    disableLogger: options.disableLogger,
  })

  return {
    handler: (request: Request) => app.handler(request, Context.empty()),
    dispose: app.dispose,
  }
}
