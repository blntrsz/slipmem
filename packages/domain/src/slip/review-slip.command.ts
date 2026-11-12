import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { SlipId } from "./slip.id.ts";

/** Only a captured slip can be reviewed. */
export class SlipNotCaptured extends Domain.Rejection("SlipNotCaptured") {}

export class SlipReviewed extends Domain.Event("SlipReviewed", {
  reviewCount: Schema.Int,
}) {}

/** Record one successful review of a slip. */
export class ReviewSlip extends Domain.Command("ReviewSlip", {
  target: SlipId,
  events: [SlipReviewed],
  rejects: [SlipNotCaptured],
  reply: { reviews: Schema.Int },
}) {}
