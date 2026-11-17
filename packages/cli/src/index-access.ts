import {
  makeMarkdownSearchIndex,
  type MarkdownError,
  type MarkdownSearchIndexShape,
} from "@slipmem/core"
import { Effect } from "effect"
import { indexConfig, type CliContext } from "./context.js"

/**
 * Opens the disposable index and always closes its SQLite handle. The index is
 * derived data; callers must refresh or rebuild before trusting a read.
 */
export const withSearchIndex = <A>(
  context: CliContext,
  root: string,
  run: (index: MarkdownSearchIndexShape) => Effect.Effect<A, MarkdownError>,
): Effect.Effect<A, MarkdownError> =>
  Effect.gen(function* () {
    const index = yield* makeMarkdownSearchIndex(indexConfig(context, root))
    return yield* run(index).pipe(Effect.ensuring(index.close()))
  })
