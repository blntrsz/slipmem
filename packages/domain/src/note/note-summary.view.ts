import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Note } from "./note.aggregate.ts";
import { NoteKind } from "./note.kind.ts";

/** The client-safe projection of one Zettelkasten note. */
export class NoteSummary extends Domain.View("NoteSummary", {
  from: [Note],
  key: Note,
  state: Schema.Struct({
    kind: Schema.NullOr(NoteKind),
    title: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    content: Schema.NullOr(Schema.String),
  }),
  initial: { kind: null, title: null, source: null, content: null },
  evolve: {
    FleetingNoteCaptured: (_, event) => ({
      kind: "fleeting" as const,
      title: null,
      source: null,
      content: event.content,
    }),
    LiteratureNoteRecorded: (_, event) => ({
      kind: "literature" as const,
      title: null,
      source: event.source,
      content: event.content,
    }),
    PermanentNoteWritten: (_, event) => ({
      kind: "permanent" as const,
      title: event.title,
      source: null,
      content: event.content,
    }),
  },
}) {}
