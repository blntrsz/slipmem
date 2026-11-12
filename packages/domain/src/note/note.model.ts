import * as Domain from "@alchemy.run/domain";
import { Note } from "./note.aggregate.ts";
import { NoteList } from "./note-list.view.ts";

/** The whole slip box: the note aggregate and its read models. */
export class SlipMem extends Domain.Model("SlipMem", {
  aggregates: [Note],
  views: [NoteList],
}) {}
