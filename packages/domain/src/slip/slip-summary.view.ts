import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Slip } from "./slip.aggregate.ts";

/** The client-safe projection of one slip. */
export class SlipSummary extends Domain.View("SlipSummary", {
  from: [Slip],
  key: Slip,
  state: Schema.Struct({
    prompt: Schema.NullOr(Schema.String),
    answer: Schema.NullOr(Schema.String),
    reviews: Schema.Int,
  }),
  initial: { prompt: null, answer: null, reviews: 0 },
  evolve: {
    SlipCaptured: (_, event) => ({
      prompt: event.prompt,
      answer: event.answer,
      reviews: 0,
    }),
    SlipReviewed: (view, event) => ({ ...view, reviews: event.reviewCount }),
  },
}) {}
