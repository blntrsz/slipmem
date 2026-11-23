import { Note } from "@slipmem/schemas/note"
import { Effect, Layer } from "effect"
import { MarkdownNoteRepository } from "../markdown/repository.js"
import { MarkdownSearchIndex } from "../markdown/search-index.js"
import { NoteService } from "./note.service"

/**
 * Adapts the Markdown repository and derived index to the existing
 * `NoteService` contract so a surface can switch by changing one Layer.
 *
 * List and title results use the same default/maximum bound and newest-first
 * ordering as the SQLite implementation, so a storage cutover does not change
 * how many notes or which notes a caller sees.
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
      list: (input) =>
        repository.list({ limit: input.limit }).pipe(Effect.orDie),
      listTitles: (input) =>
        repository.listTitles({ limit: input.limit }).pipe(
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
                // The adapter follows the cross-backend NoteService default,
                // which excludes `tags`. Direct index callers still search
                // tags by default; a NoteService caller must opt in.
                fields: input.fields ?? Note.DEFAULT_SEARCH_FIELDS,
                ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              }),
            ),
            Effect.orDie,
          ),
    })
  }),
)
