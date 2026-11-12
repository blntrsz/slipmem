import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CaptureSlip, SlipAlreadyCaptured, SlipCaptured, EmptySlip } from "./capture-slip.command.ts";
import { ReviewSlip, SlipNotCaptured, SlipReviewed } from "./review-slip.command.ts";
import { SlipId } from "./slip.id.ts";

const SlipState = Schema.Union([
  Schema.TaggedStruct("Uncaptured", {}),
  Schema.TaggedStruct("Captured", {
    prompt: Schema.String,
    answer: Schema.String,
    reviews: Schema.Int,
  }),
]);
type SlipState = typeof SlipState.Type;

/**
 * One memory slip. The prompt is the cue; the answer is what should come back
 * when the slip is reviewed.
 */
export class Slip extends Domain.Aggregate("Slip", {
  id: SlipId,
  state: SlipState,
  initial: { _tag: "Uncaptured" },
  commands: [CaptureSlip, ReviewSlip],
  decide: {
    CaptureSlip: (slip, command) => {
      if (slip._tag !== "Uncaptured") return new SlipAlreadyCaptured();
      if (command.prompt.trim() === "") return new EmptySlip({ field: "prompt" });
      if (command.answer.trim() === "") return new EmptySlip({ field: "answer" });
      return [new SlipCaptured({ prompt: command.prompt.trim(), answer: command.answer.trim() })];
    },
    ReviewSlip: (slip) =>
      slip._tag !== "Captured"
        ? new SlipNotCaptured()
        : [new SlipReviewed({ reviewCount: slip.reviews + 1 })],
  },
  evolve: {
    SlipCaptured: (_, event) => ({
      _tag: "Captured" as const,
      prompt: event.prompt,
      answer: event.answer,
      reviews: 0,
    }),
    SlipReviewed: (slip, event) =>
      slip._tag === "Captured" ? { ...slip, reviews: event.reviewCount } : slip,
  },
  reply: {
    ReviewSlip: (slip) => ({ reviews: slip._tag === "Captured" ? slip.reviews : 0 }),
  },
}) {}

export type { SlipState };
