import * as Domain from "@alchemy.run/domain";
import { SlipMem } from "./note.model.ts";

/** What the browser may send and read. */
export class NoteApi extends Domain.Api("NoteApi", {
  model: SlipMem,
  commands: ["CaptureFleetingNote", "RecordLiteratureNote", "WritePermanentNote"],
  views: ["NoteList"],
}) {}
