import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Note } from "./note.aggregate.ts";
import { NoteId } from "./note.id.ts";
import { NoteKind } from "./note.kind.ts";

/** The single key of the collection view. */
export const NoteListKey = Schema.Literal("all");
export type NoteListKey = typeof NoteListKey.Type;

export const noteListKey: NoteListKey = "all";

/** The client-safe shape of one note in the list. */
export const ListedNote = Schema.Struct({
  id: NoteId,
  kind: NoteKind,
  title: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  content: Schema.String,
});
export type ListedNote = typeof ListedNote.Type;

const upsert = (notes: ReadonlyArray<ListedNote>, note: ListedNote): ReadonlyArray<ListedNote> => {
  const index = notes.findIndex((existing) => existing.id === note.id);
  if (index === -1) return [...notes, note];
  const next = notes.slice();
  next[index] = note;
  return next;
};

/**
 * Every note in the slip box, newest last, for the list screen.
 *
 * A view is read one key at a time, so this is a single collection keyed by
 * `NoteListKey`; each note event is routed to it regardless of the note's own
 * id. Notes are keyed by their aggregate id inside the list.
 */
export class NoteList extends Domain.View("NoteList", {
  from: [Note],
  key: NoteListKey,
  state: Schema.Struct({
    notes: Schema.Array(ListedNote),
  }),
  initial: { notes: [] },
  keyOf: {
    Note: () => noteListKey,
  },
  evolve: {
    FleetingNoteCaptured: (view, event, context) => ({
      notes: upsert(view.notes, {
        id: context.source.id,
        kind: "fleeting",
        title: null,
        source: null,
        content: event.content,
      }),
    }),
    LiteratureNoteRecorded: (view, event, context) => ({
      notes: upsert(view.notes, {
        id: context.source.id,
        kind: "literature",
        title: null,
        source: event.source,
        content: event.content,
      }),
    }),
    PermanentNoteWritten: (view, event, context) => ({
      notes: upsert(view.notes, {
        id: context.source.id,
        kind: "permanent",
        title: event.title,
        source: null,
        content: event.content,
      }),
    }),
  },
}) {}
