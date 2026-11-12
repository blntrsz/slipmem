import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { SlipId } from "./slip.id.ts";

/** A slip can only be captured once. */
export class SlipAlreadyCaptured extends Domain.Rejection("SlipAlreadyCaptured") {}

/** The prompt or answer was blank. */
export class EmptySlip extends Domain.Rejection("EmptySlip", {
  field: Schema.Literals(["prompt", "answer"]),
}) {}

export class SlipCaptured extends Domain.Event("SlipCaptured", {
  prompt: Schema.String,
  answer: Schema.String,
}) {}

/** Capture a prompt and its answer as a new memory slip. */
export class CaptureSlip extends Domain.Command("CaptureSlip", {
  target: SlipId,
  input: { prompt: Schema.String, answer: Schema.String },
  events: [SlipCaptured],
  rejects: [SlipAlreadyCaptured, EmptySlip],
}) {}
