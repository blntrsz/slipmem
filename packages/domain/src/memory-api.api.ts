import * as Domain from "@alchemy.run/domain";
import { SlipMem } from "./slip-mem.model.ts";

/** What the browser may send and read. */
export class MemoryApi extends Domain.Api("MemoryApi", {
  model: SlipMem,
  commands: [
    "CaptureSlip",
    "ReviewSlip",
    "CaptureFleetingNote",
    "RecordLiteratureNote",
    "WritePermanentNote",
  ],
  views: ["SlipSummary", "NoteSummary"],
}) {}
