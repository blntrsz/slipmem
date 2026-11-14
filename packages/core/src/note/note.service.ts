import { Note } from "@slipmem/schemas/note"
import { Context, Effect } from "effect"

// Callers must validate untrusted input with Note.ListInput before using this
// service.
export interface NoteShape {
  readonly list: (input: Note.ListInput) => Effect.Effect<ReadonlyArray<Note.Info>>
}

export class NoteService extends Context.Service<NoteService, NoteShape>()(
  "@slipmem/core/NoteService",
) {}
