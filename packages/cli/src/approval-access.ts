import {
  makeApprovalService,
  type ApprovalError,
  type ApprovalServiceShape,
  type MarkdownError,
} from "@slipmem/core"
import { Effect } from "effect"
import { openRepository, type CliContext } from "./context.js"

/**
 * Opens the local approval service for human-only review/apply/reject. This is
 * the same service MCP writes proposals through; the CLI never reimplements
 * hashing, expiry, or proposal validation.
 */
export const withApprovalService = <A>(
  context: CliContext,
  root: string,
  run: (service: ApprovalServiceShape) => Effect.Effect<A, ApprovalError>,
): Effect.Effect<A, ApprovalError | MarkdownError> =>
  Effect.gen(function* () {
    const repository = yield* openRepository(context, root)
    const service = yield* makeApprovalService(repository, {
      now: context.now,
      env: context.env,
      ...(context.env.SLIPMEM_ACTOR === undefined
        ? {}
        : { actor: context.env.SLIPMEM_ACTOR }),
    })
    return yield* run(service)
  })
