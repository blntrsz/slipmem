import { Note } from "@slipmem/schemas/note"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect, Layer } from "effect"
import { MarkdownNoteRepository } from "../markdown/repository.js"
import { MarkdownSearchIndex } from "../markdown/search-index.js"
import { NoteService } from "./note.service"

/**
 * Adapts the Markdown repository and derived index to the existing
 * `NoteService` contract so a surface can switch by changing one Layer.
 *
 * It is intentionally not wired into the server or web app yet. The existing
 * SQLite service remains the runtime default until the Phase 5 cutover.
 */
export const MarkdownNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const repository = yield* MarkdownNoteRepository
    const index = yield* MarkdownSearchIndex

    return NoteService.of({
      list: () =>
        repository
          .list({ limit: Markdown.MAX_SEARCH_LIMIT })
          .pipe(Effect.orDie),
      listTitles: () =>
        repository
          .listTitles({ limit: Markdown.MAX_SEARCH_LIMIT })
          .pipe(
            Effect.map((titles) =>
              titles.map(({ id, type, title }) => ({ id, type, title })),
            ),
            Effect.orDie,
          ),
      search: (input: Note.SearchInput) =>
        index
          .refresh()
          .pipe(
            Effect.flatMap(() =>
              index.searchNotes({
                query: input.query,
                ...(input.fields === undefined ? {} : { fields: input.fields }),
                ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              }),
            ),
            Effect.orDie,
          ),
    })
  }),
)
