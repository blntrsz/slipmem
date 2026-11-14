import { Note } from "@slipmem/schemas/note"
import { Context, Effect } from "effect"

// Callers must validate untrusted input with the operation's Note input schema
// before using this service.
export interface NoteShape {
  readonly list: (input: Note.ListInput) => Effect.Effect<ReadonlyArray<Note.Info>>
  readonly listTitles: (
    input: Note.ListTitlesInput,
  ) => Effect.Effect<ReadonlyArray<Note.TitleInfo>>
}

export class NoteService extends Context.Service<NoteService, NoteShape>()(
  "@slipmem/core/NoteService",
) {}
