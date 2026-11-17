import {
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndexFromRepository,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import type { Note } from "@slipmem/schemas/note"
import { Layer } from "effect"

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

/** Repository plus disposable search index for one note root. */
export const makeMarkdownLayer = (options: MarkdownLayerOptions) => {
  const repository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const index = MarkdownSearchIndexFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  ).pipe(Layer.provide(repository))

  return Layer.merge(repository, index)
}

/**
 * The JSON representation of a note. It extends the existing `Note.Info`
 * wire union with the metadata the web UI and API clients need to render
 * topics, paths, and citations without a second request.
 */
export type ApiNote = Note.Info & {
  readonly topics: ReadonlyArray<string>
  readonly path: string
  readonly contentHash: string
  readonly provenance?: { readonly source?: string; readonly actor?: string }
}

export const toApiNote = (note: ParsedMarkdownNote): ApiNote => ({
  ...note.info,
  topics: note.metadata.topics ?? [],
  path: note.path,
  contentHash: note.contentHash,
  ...(note.metadata.provenance === undefined
    ? {}
    : { provenance: note.metadata.provenance }),
})
