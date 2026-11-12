import * as Domain from "@alchemy.run/domain";
import { Note } from "./note/note.aggregate.ts";
import { NoteSummary } from "./note/note-summary.view.ts";
import { Slip } from "./slip/slip.aggregate.ts";
import { SlipSummary } from "./slip/slip-summary.view.ts";

/** The whole slip box: every aggregate and view hosted together. */
export class SlipMem extends Domain.Model("SlipMem", {
  aggregates: [Slip, Note],
  views: [SlipSummary, NoteSummary],
}) {}
