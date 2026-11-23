import type {
  ApprovalService,
  MarkdownNoteRepository,
  MarkdownSearchIndex,
  WikiService,
} from "@slipmem/core"
import { Cause, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { MarkdownApiRoutes } from "./api"
import { makeMarkdownLayer } from "./markdown"

/**
 * Services that `makeAppLayer` provides to every extra route layer. Extra
 * routes declare these requirements instead of casting them away, so the
 * shared repository/index graph is visible to the type checker.
 */
export type AppExtraRequirements =
  | HttpRouter.HttpRouter
  | MarkdownNoteRepository
  | MarkdownSearchIndex
  | ApprovalService
  | WikiService

export interface AppLayerOptions<Extra = never, ExtraError = never> {
  /** Exact cache directory for the disposable index. Defaults to XDG cache. */
  readonly cacheDir?: string
  /** Injectable clock for deterministic note filenames in tests. */
  readonly now?: () => number
  /**
   * Additional routes supplied by another surface. They are built with the
   * same Markdown repository and search index as the JSON API, so an HTTP MCP
   * endpoint added here sees exactly the same files.
   *
   * A route layer must declare its `HttpRouter` requirement instead of casting
   * it away; `HttpRouter.toWebHandler` supplies the router when the app is
   * built.
   */
  readonly extraRoutes?: Layer.Layer<Extra, ExtraError, AppExtraRequirements>
}

/**
 * Combines the canonical JSON API with any caller-supplied routes over one
 * Markdown note root and one disposable index.
 *
 * There is no SQLite note database in this layer. If the repository is not
 * initialized, building the layer fails and the process exits with the
 * `slipmem init` guidance from the core root resolver.
 */
export const makeAppLayer = <Extra = never, ExtraError = never>(
  noteRoot: string,
  options: AppLayerOptions<Extra, ExtraError> = {},
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

export interface ApiHandlerOptions<Extra = never, ExtraError = never>
  extends AppLayerOptions<Extra, ExtraError> {
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
 * Builds a Web `fetch` handler for the Markdown-backed JSON API. Build it once
 * at module scope and call `dispose` when the host shuts down.
 *
 * `ready` is the app-layer build signal, not a health/index scan. It resolves
 * after the one repository/index/service graph is built and rejects with the
 * build failure (for example a missing note root) even though `handler` itself
 * only rejects per request.
 */
export const makeApiHandler = <Extra = never, ExtraError = never>(
  noteRoot: string,
  options: ApiHandlerOptions<Extra, ExtraError> = {},
) => {
  const { ready, resolveReady, rejectReady } = makeReadySignal()
  const appLayer = makeAppLayer(noteRoot, options).pipe(
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
  const app = HttpRouter.toWebHandler(appLayer, {
    disableLogger: options.disableLogger,
  })

  return {
    handler: (request: Request) => app.handler(request, Context.empty()),
    dispose: app.dispose,
    ready,
  }
}
