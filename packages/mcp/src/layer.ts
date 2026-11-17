import {
  MarkdownNoteRepositoryLive,
  MarkdownSearchIndexFromRepository,
} from "@slipmem/core"
import { WikiServiceLive } from "@slipmem/core/wiki"
import { Layer } from "effect"
import { McpApprovalServiceLive } from "./approval"
import type { McpServerOptions } from "./config"

/**
 * Repository, disposable search index, and approval service for one note root.
 *
 * Both the stdio server and any HTTP registration share this layer shape, so
 * the same tools see the same files and the same pending proposals.
 */
export const makeMarkdownServicesLayer = (options: McpServerOptions) => {
  const repository = MarkdownNoteRepositoryLive({
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const index = MarkdownSearchIndexFromRepository(
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  ).pipe(Layer.provide(repository))

  const approval = McpApprovalServiceLive(options).pipe(Layer.provide(repository))

  const wiki = WikiServiceLive({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }).pipe(Layer.provide(repository))

  return Layer.mergeAll(repository, index, approval, wiki)
}
