import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@effect/vitest";
import { EmptySlip, SlipCaptured, CaptureSlip } from "../src/slip/capture-slip.command.ts";
import { ReviewSlip, SlipNotCaptured, SlipReviewed } from "../src/slip/review-slip.command.ts";
import { Slip } from "../src/slip/slip.aggregate.ts";
import { SlipSummary } from "../src/slip/slip-summary.view.ts";
import { SlipMem } from "../src/slip-mem.model.ts";

const story = Story.make(SlipMem, {});
const slip = Slip.ref("slip-1");

describe("Slip", () => {
  it.effect("captures a slip and projects its summary", () =>
    story(
      Story.when(slip, new CaptureSlip({ prompt: "What is 2 + 2?", answer: "4" })),
      Story.then(slip, new SlipCaptured({ prompt: "What is 2 + 2?", answer: "4" })),
      Story.view(SlipSummary, slip, {
        prompt: "What is 2 + 2?",
        answer: "4",
        reviews: 0,
      }),
    ),
  );

  it.effect("counts reviews and replies with the new count", () =>
    story(
      Story.given(slip, new SlipCaptured({ prompt: "Capital of France?", answer: "Paris" })),
      Story.when(slip, new ReviewSlip()),
      Story.then(slip, new SlipReviewed({ reviewCount: 1 })),
      Story.replied({ reviews: 1 }),
      Story.view(SlipSummary, slip, (summary) => expect(summary.reviews).toBe(1)),
    ),
  );

  it.effect("rejects an empty prompt", () =>
    story(
      Story.when(slip, new CaptureSlip({ prompt: "   ", answer: "4" })),
      Story.rejected(new EmptySlip({ field: "prompt" })),
    ),
  );

  it.effect("rejects reviewing a slip that was never captured", () =>
    story(
      Story.when(slip, new ReviewSlip()),
      Story.rejected(new SlipNotCaptured()),
    ),
  );
});
