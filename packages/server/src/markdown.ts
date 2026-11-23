import {
  ApprovalServiceLive,
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndex,
  MarkdownSearchIndexResilientFromRepository,
  WikiServiceLive,
  type NoteProjection,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Effect, Layer } from "effect"

/**
 * Configuration shared by every Markdown-backed HTTP surface.
 *
 * The note root is the only source of truth. `cacheDir` and `now` are
 * injectable so tests and operators can isolate the disposable index and
 * produce deterministic filenames.
 */
export interface MarkdownLayerOptions {
  readonly root: string
  readonly cacheDir?: string
  readonly now?: () => number
}

/**
 * Repository, disposable search index, approval queue, and read-only wiki
 * service for one note root. The wiki and approval services receive the same
 * repository instance as the API, so every surface observes the same files.
 */
export const makeMarkdownLayer = (options: MarkdownLayerOptions) => {
  const repository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const index = MarkdownSearchIndexResilientFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  )
  // A damaged cache must not prevent note reads or human approvals from
  // starting. The resilient index opens lazily and repairs only itself; the
  // repository and approval queue never depend on a successful SQLite open.
  // Approval refreshes the same index instance the API reads, so a successful
  // human approval is immediately drifted-free for the next `check` or health
  // response. The service treats a cache failure as a warning, not a rollback.
  const approval = Layer.unwrap(
    Effect.gen(function* () {
      const searchIndex = yield* MarkdownSearchIndex
      return ApprovalServiceLive({
        ...(options.now === undefined ? {} : { now: options.now }),
        refreshIndex: () => searchIndex.refresh().pipe(Effect.asVoid),
      })
    }),
  ).pipe(Layer.provide(index))
  const services = Layer.mergeAll(
    index,
    WikiServiceLive(
      options.now === undefined ? {} : { now: options.now },
    ),
    approval,
  ).pipe(Layer.provide(repository))

  return Layer.merge(repository, services)
}

/**
 * The JSON representation of a note. It extends the canonical Markdown
 * projection with the metadata the web UI and API clients need to render
 * tags, paths, and citations without a second request. The projection keeps
 * the long-standing wire shape, so existing clients see no change.
 */
export type ApiNote = NoteProjection & {
  readonly tags: ReadonlyArray<string>
  readonly path: string
  readonly contentHash: string
  readonly provenance?: { readonly source?: string; readonly actor?: string }
}

export const toApiNote = (note: ParsedMarkdownNote): ApiNote => ({
  ...note.projection,
  tags: note.metadata.tags ?? [],
  path: note.path,
  contentHash: note.contentHash,
  ...(note.metadata.provenance === undefined
    ? {}
    : { provenance: note.metadata.provenance }),
})
