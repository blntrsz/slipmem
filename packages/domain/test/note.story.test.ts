import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CaptureFleetingNote,
  FleetingNoteCaptured,
} from "../src/note/capture-fleeting-note.command.ts";
import { Note } from "../src/note/note.aggregate.ts";
import { NoteId } from "../src/note/note.id.ts";
import { NoteList, noteListKey } from "../src/note/note-list.view.ts";
import { NoteContentLimit } from "../src/note/note.kind.ts";
import { EmptyNote, NoteAlreadyExists, NoteTooLong } from "../src/note/note.rejection.ts";
import {
  LiteratureNoteRecorded,
  RecordLiteratureNote,
} from "../src/note/record-literature-note.command.ts";
import {
  PermanentNoteWritten,
  WritePermanentNote,
} from "../src/note/write-permanent-note.command.ts";
import { SlipMem } from "../src/note/note.model.ts";

const story = Story.make(SlipMem, {});
const note = Note.ref("note-1");

describe("Note", () => {
  it.effect("captures a fleeting note and lists it", () =>
    story(
      Story.when(note, new CaptureFleetingNote({ content: "  Ask Sam about spaced repetition.  " })),
      Story.then(note, new FleetingNoteCaptured({ content: "Ask Sam about spaced repetition." })),
      Story.view(NoteList, noteListKey, {
        notes: [
          {
            id: NoteId.make("note-1"),
            kind: "fleeting",
            title: null,
            source: null,
            content: "Ask Sam about spaced repetition.",
          },
        ],
      }),
    ),
  );

  it.effect("records a literature note with its source", () =>
    story(
      Story.when(
        note,
        new RecordLiteratureNote({
          source: "  How to Take Smart Notes, ch. 2  ",
          content: "  Writing forces you to test whether you understand an idea.  ",
        }),
      ),
      Story.then(
        note,
        new LiteratureNoteRecorded({
          source: "How to Take Smart Notes, ch. 2",
          content: "Writing forces you to test whether you understand an idea.",
        }),
      ),
      Story.view(NoteList, noteListKey, {
        notes: [
          {
            id: NoteId.make("note-1"),
            kind: "literature",
            title: null,
            source: "How to Take Smart Notes, ch. 2",
            content: "Writing forces you to test whether you understand an idea.",
          },
        ],
      }),
    ),
  );

  it.effect("writes a permanent note with its title", () =>
    story(
      Story.when(
        note,
        new WritePermanentNote({
          title: "  Writing is thinking  ",
          content: "  An idea is not understood until it can be restated in full sentences.  ",
        }),
      ),
      Story.then(
        note,
        new PermanentNoteWritten({
          title: "Writing is thinking",
          content: "An idea is not understood until it can be restated in full sentences.",
        }),
      ),
      Story.view(NoteList, noteListKey, {
        notes: [
          {
            id: NoteId.make("note-1"),
            kind: "permanent",
            title: "Writing is thinking",
            source: null,
            content: "An idea is not understood until it can be restated in full sentences.",
          },
        ],
      }),
    ),
  );

  it.effect("lists notes of every kind together in creation order", () => {
    const second = Note.ref("note-2");
    const third = Note.ref("note-3");
    return story(
      Story.given(note, new FleetingNoteCaptured({ content: "A quick thought." })),
      Story.given(second, new LiteratureNoteRecorded({ source: "A book", content: "A passage." })),
      Story.given(third, new PermanentNoteWritten({ title: "One idea", content: "In my words." })),
      Story.view(NoteList, noteListKey, {
        notes: [
          {
            id: NoteId.make("note-1"),
            kind: "fleeting",
            title: null,
            source: null,
            content: "A quick thought.",
          },
          {
            id: NoteId.make("note-2"),
            kind: "literature",
            title: null,
            source: "A book",
            content: "A passage.",
          },
          {
            id: NoteId.make("note-3"),
            kind: "permanent",
            title: "One idea",
            source: null,
            content: "In my words.",
          },
        ],
      }),
    );
  });

  it.effect("rejects a note with empty content", () =>
    story(
      Story.when(note, new CaptureFleetingNote({ content: "   " })),
      Story.rejected(new EmptyNote({ field: "content" })),
    ),
  );

  it.effect("rejects a literature note without a source", () =>
    story(
      Story.when(note, new RecordLiteratureNote({ source: "  ", content: "An idea." })),
      Story.rejected(new EmptyNote({ field: "source" })),
    ),
  );

  it.effect("rejects a permanent note without a title", () =>
    story(
      Story.when(note, new WritePermanentNote({ title: "  ", content: "An idea." })),
      Story.rejected(new EmptyNote({ field: "title" })),
    ),
  );

  it.effect("rejects a note that already exists", () =>
    story(
      Story.given(note, new FleetingNoteCaptured({ content: "A first thought." })),
      Story.when(note, new WritePermanentNote({ title: "Later", content: "A second thought." })),
      Story.rejected(new NoteAlreadyExists()),
    ),
  );

  it.effect("accepts a fleeting note exactly at its limit", () => {
    const content = "a".repeat(NoteContentLimit.fleeting);
    return story(
      Story.when(note, new CaptureFleetingNote({ content })),
      Story.then(note, new FleetingNoteCaptured({ content })),
    );
  });

  it.effect("rejects a fleeting note over its limit", () =>
    story(
      Story.when(
        note,
        new CaptureFleetingNote({ content: "a".repeat(NoteContentLimit.fleeting + 1) }),
      ),
      Story.rejected(
        new NoteTooLong({
          kind: "fleeting",
          field: "content",
          maxLength: NoteContentLimit.fleeting,
          actualLength: NoteContentLimit.fleeting + 1,
        }),
      ),
    ),
  );

  it.effect("accepts a literature note exactly at its limit", () => {
    const content = "a".repeat(NoteContentLimit.literature);
    return story(
      Story.when(note, new RecordLiteratureNote({ source: "A source", content })),
      Story.then(note, new LiteratureNoteRecorded({ source: "A source", content })),
    );
  });

  it.effect("rejects a literature note over its limit", () =>
    story(
      Story.when(
        note,
        new RecordLiteratureNote({
          source: "A source",
          content: "a".repeat(NoteContentLimit.literature + 1),
        }),
      ),
      Story.rejected(
        new NoteTooLong({
          kind: "literature",
          field: "content",
          maxLength: NoteContentLimit.literature,
          actualLength: NoteContentLimit.literature + 1,
        }),
      ),
    ),
  );

  it.effect("accepts a permanent note exactly at its limit", () => {
    const content = "a".repeat(NoteContentLimit.permanent);
    return story(
      Story.when(note, new WritePermanentNote({ title: "One idea", content })),
      Story.then(note, new PermanentNoteWritten({ title: "One idea", content })),
    );
  });

  it.effect("rejects a permanent note over its limit", () =>
    story(
      Story.when(
        note,
        new WritePermanentNote({
          title: "One idea",
          content: "a".repeat(NoteContentLimit.permanent + 1),
        }),
      ),
      Story.rejected(
        new NoteTooLong({
          kind: "permanent",
          field: "content",
          maxLength: NoteContentLimit.permanent,
          actualLength: NoteContentLimit.permanent + 1,
        }),
      ),
    ),
  );

  it.effect("checks the limit after trimming whitespace", () => {
    const content = ` ${"a".repeat(NoteContentLimit.fleeting)} `;
    return story(
      Story.when(note, new CaptureFleetingNote({ content })),
      Story.then(
        note,
        new FleetingNoteCaptured({ content: "a".repeat(NoteContentLimit.fleeting) }),
      ),
    );
  });

  it.effect("limits use the documented sizes", () =>
    Effect.sync(() =>
      expect(NoteContentLimit).toEqual({
        fleeting: 1_000,
        literature: 5_000,
        permanent: 2_000,
      }),
    ),
  );
});
