import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NoteId } from "./note.id.ts";
import { EmptyNote, NoteAlreadyExists, NoteTooLong } from "./note.rejection.ts";

export class FleetingNoteCaptured extends Domain.Event("FleetingNoteCaptured", {
  content: Schema.String,
}) {}

/** Capture a quick thought before it is lost. */
export class CaptureFleetingNote extends Domain.Command("CaptureFleetingNote", {
  target: NoteId,
  input: { content: Schema.String },
  events: [FleetingNoteCaptured],
  rejects: [NoteAlreadyExists, EmptyNote, NoteTooLong],
}) {}
