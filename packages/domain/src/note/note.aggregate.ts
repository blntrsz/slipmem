import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  CaptureFleetingNote,
  FleetingNoteCaptured,
} from "./capture-fleeting-note.command.ts";
import { NoteContentLimit, type NoteKind } from "./note.kind.ts";
import { EmptyNote, NoteAlreadyExists, NoteTooLong, type NoteField } from "./note.rejection.ts";
import { NoteId } from "./note.id.ts";
import {
  LiteratureNoteRecorded,
  RecordLiteratureNote,
} from "./record-literature-note.command.ts";
import {
  PermanentNoteWritten,
  WritePermanentNote,
} from "./write-permanent-note.command.ts";

const NoteState = Schema.Union([
  Schema.TaggedStruct("NoNote", {}),
  Schema.TaggedStruct("FleetingNote", {
    content: Schema.String,
  }),
  Schema.TaggedStruct("LiteratureNote", {
    source: Schema.String,
    content: Schema.String,
  }),
  Schema.TaggedStruct("PermanentNote", {
    title: Schema.String,
    content: Schema.String,
  }),
]);
type NoteState = typeof NoteState.Type;

/** Trim a required field, rejecting it when nothing is left. */
const required = (field: NoteField, value: string): string | EmptyNote => {
  const trimmed = value.trim();
  return trimmed === "" ? new EmptyNote({ field }) : trimmed;
};

/** Trim content and enforce the limit for its note kind. */
const content = (kind: NoteKind, value: string): string | EmptyNote | NoteTooLong => {
  const trimmed = value.trim();
  if (trimmed === "") return new EmptyNote({ field: "content" });
  const maxLength = NoteContentLimit[kind];
  return trimmed.length > maxLength
    ? new NoteTooLong({
        kind,
        field: "content",
        maxLength,
        actualLength: trimmed.length,
      })
    : trimmed;
};

/**
 * One Zettelkasten note. Its kind is fixed when it is created: a fleeting
 * capture, a literature note tied to a source, or a permanent note with a
 * title. Each kind has its own content limit (see `NoteContentLimit`).
 */
export class Note extends Domain.Aggregate("Note", {
  id: NoteId,
  state: NoteState,
  initial: { _tag: "NoNote" },
  commands: [CaptureFleetingNote, RecordLiteratureNote, WritePermanentNote],
  decide: {
    CaptureFleetingNote: (note, command) => {
      if (note._tag !== "NoNote") return new NoteAlreadyExists();
      const noteContent = content("fleeting", command.content);
      return typeof noteContent === "string"
        ? [new FleetingNoteCaptured({ content: noteContent })]
        : noteContent;
    },
    RecordLiteratureNote: (note, command) => {
      if (note._tag !== "NoNote") return new NoteAlreadyExists();
      const source = required("source", command.source);
      if (typeof source !== "string") return source;
      const noteContent = content("literature", command.content);
      if (typeof noteContent !== "string") return noteContent;
      return [new LiteratureNoteRecorded({ source, content: noteContent })];
    },
    WritePermanentNote: (note, command) => {
      if (note._tag !== "NoNote") return new NoteAlreadyExists();
      const title = required("title", command.title);
      if (typeof title !== "string") return title;
      const noteContent = content("permanent", command.content);
      if (typeof noteContent !== "string") return noteContent;
      return [new PermanentNoteWritten({ title, content: noteContent })];
    },
  },
  evolve: {
    FleetingNoteCaptured: (_, event) => ({
      _tag: "FleetingNote" as const,
      content: event.content,
    }),
    LiteratureNoteRecorded: (_, event) => ({
      _tag: "LiteratureNote" as const,
      source: event.source,
      content: event.content,
    }),
    PermanentNoteWritten: (_, event) => ({
      _tag: "PermanentNote" as const,
      title: event.title,
      content: event.content,
    }),
  },
}) {}

export type { NoteState };
