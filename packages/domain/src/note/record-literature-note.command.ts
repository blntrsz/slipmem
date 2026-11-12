import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NoteId } from "./note.id.ts";
import { EmptyNote, NoteAlreadyExists, NoteTooLong } from "./note.rejection.ts";

export class LiteratureNoteRecorded extends Domain.Event("LiteratureNoteRecorded", {
  source: Schema.String,
  content: Schema.String,
}) {}

/** Record what one source says, in the writer's own words. */
export class RecordLiteratureNote extends Domain.Command("RecordLiteratureNote", {
  target: NoteId,
  input: { source: Schema.String, content: Schema.String },
  events: [LiteratureNoteRecorded],
  rejects: [NoteAlreadyExists, EmptyNote, NoteTooLong],
}) {}
