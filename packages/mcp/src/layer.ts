import {
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndexFromRepository,
} from "@slipmem/core"
import { Layer } from "effect"
import type { McpServerOptions } from "./config"

/**
 * Repository plus disposable search index for one note root.
 *
 * Both the stdio server and any HTTP registration share this layer shape, so
 * the same tools see the same files and the same derived index.
 */
export const makeMarkdownServicesLayer = (options: McpServerOptions) => {
  const repository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const index = MarkdownSearchIndexFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  ).pipe(Layer.provide(repository))

  return Layer.merge(repository, index)
}
