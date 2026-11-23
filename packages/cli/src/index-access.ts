import {
  makeMarkdownSearchIndex,
  makeMarkdownSearchIndexResilient,
  type MarkdownError,
  type MarkdownSearchIndexShape,
} from "@slipmem/core"
import { Effect } from "effect"
import { indexConfig, type CliContext } from "./context.js"

const withIndex = <A>(
  open: () => Effect.Effect<MarkdownSearchIndexShape, MarkdownError>,
  run: (index: MarkdownSearchIndexShape) => Effect.Effect<A, MarkdownError>,
): Effect.Effect<A, MarkdownError> =>
  Effect.gen(function* () {
    const index = yield* open()
    return yield* run(index).pipe(Effect.ensuring(index.close()))
  })

/**
 * Opens the disposable index and always closes its SQLite handle. The index is
 * derived data; callers must refresh or rebuild before trusting a read.
 */
export const withSearchIndex = <A>(
  context: CliContext,
  root: string,
  run: (index: MarkdownSearchIndexShape) => Effect.Effect<A, MarkdownError>,
): Effect.Effect<A, MarkdownError> =>
  withIndex(
    () => makeMarkdownSearchIndex(indexConfig(context, root)),
    run,
  )

/**
 * Read-side variant used by search, tags, and post-approval refresh. A corrupt
 * cache is repaired once in core instead of failing the command; the note files
 * remain the only source of truth. Recovery commands still use the strict
 * {@link withSearchIndex} so `check` can report damage instead of hiding it.
 */
export const withResilientSearchIndex = <A>(
  context: CliContext,
  root: string,
  run: (index: MarkdownSearchIndexShape) => Effect.Effect<A, MarkdownError>,
): Effect.Effect<A, MarkdownError> =>
  withIndex(
    () => makeMarkdownSearchIndexResilient(indexConfig(context, root)),
    run,
  )
