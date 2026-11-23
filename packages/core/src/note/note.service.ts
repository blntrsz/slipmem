import { Note } from "@slipmem/schemas/note"
import { Context, Effect } from "effect"

// Callers must validate untrusted input with the operation's Note input schema
// before using this service.
//
// Both implementations are deliberately bounded: `list` and `listTitles` apply
// `Note.DEFAULT_LIST_LIMIT` when `limit` is omitted and clamp an explicit limit
// to `Note.MAX_LIST_LIMIT`; `search` applies the same convention. List order is
// newest first with the same tie-break rule.
//
// Search shares its bound, field/kind filters, default field set, and output
// shape across backends. Matching itself is backend-defined: the SQLite service
// folds ASCII case and matches substrings, while the Markdown FTS5 index uses
// SQLite's unicode61 tokenizer (Unicode case folding and Latin diacritic
// removal) and matches tokens. Non-ASCII case/diacritic queries and partial
// tokens can therefore differ; the Markdown bounded linear fallback follows the
// ASCII/substring rule. Tags are opt-in: `fields: ["tags"]` matches where the
// backend stores tags (Markdown) and returns no matches where it does not
// (SQLite note rows have no tag column). The shared default never includes
// tags, so tag text alone does not affect the default result in either service.
export interface NoteShape {
  readonly list: (input: Note.ListInput) => Effect.Effect<ReadonlyArray<Note.Info>>
  readonly listTitles: (
    input: Note.ListTitlesInput,
  ) => Effect.Effect<ReadonlyArray<Note.TitleInfo>>
  readonly search: (input: Note.SearchInput) => Effect.Effect<ReadonlyArray<Note.Info>>
}

export class NoteService extends Context.Service<NoteService, NoteShape>()(
  "@slipmem/core/NoteService",
) {}
