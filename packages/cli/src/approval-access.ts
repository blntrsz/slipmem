import {
  makeApprovalService,
  type ApprovalError,
  type ApprovalServiceShape,
  type MarkdownError,
} from "@slipmem/core"
import { Effect } from "effect"
import { openRepository, type CliContext } from "./context.js"
import { withSearchIndex } from "./index-access.js"

export interface ApprovalAccessOptions {
  /**
   * Refresh the disposable index after a durable approval. The service owns the
   * fail-open behavior: a missing or broken cache yields a warning, never an
   * undone note.
   */
  readonly refreshIndex?: boolean
}

/**
 * Opens the local approval service for human-only review/apply/reject. This is
 * the same service MCP writes proposals through; the CLI never reimplements
 * hashing, expiry, or proposal validation.
 */
export const withApprovalService = <A>(
  context: CliContext,
  root: string,
  run: (service: ApprovalServiceShape) => Effect.Effect<A, ApprovalError>,
  options: ApprovalAccessOptions = {},
): Effect.Effect<A, ApprovalError | MarkdownError> =>
  Effect.gen(function* () {
    const repository = yield* openRepository(context, root)
    const refreshIndex =
      options.refreshIndex === true
        ? () =>
            withSearchIndex(context, root, (index) =>
              index.refresh().pipe(Effect.asVoid),
            )
        : undefined
    const service = yield* makeApprovalService(repository, {
      now: context.now,
      env: context.env,
      ...(context.env.SLIPMEM_ACTOR === undefined
        ? {}
        : { actor: context.env.SLIPMEM_ACTOR }),
      ...(refreshIndex === undefined ? {} : { refreshIndex }),
    })
    return yield* run(service)
  })
