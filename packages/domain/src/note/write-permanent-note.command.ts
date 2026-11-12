import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NoteId } from "./note.id.ts";
import { EmptyNote, NoteAlreadyExists, NoteTooLong } from "./note.rejection.ts";

export class PermanentNoteWritten extends Domain.Event("PermanentNoteWritten", {
  title: Schema.String,
  content: Schema.String,
}) {}

/** Write one durable idea in the writer's own words. */
export class WritePermanentNote extends Domain.Command("WritePermanentNote", {
  target: NoteId,
  input: { title: Schema.String, content: Schema.String },
  events: [PermanentNoteWritten],
  rejects: [NoteAlreadyExists, EmptyNote, NoteTooLong],
}) {}
