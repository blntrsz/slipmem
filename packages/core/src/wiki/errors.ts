import { Data } from "effect"

export type WikiErrorCode =
  | "invalid-topic"
  | "invalid-limit"
  | "invalid-mode"
  | "repository-failure"
  | "synthesis-config"
  | "synthesis-adapter-unsupported"
  | "synthesis-failed"
  | "synthesis-output-invalid"
  | "synthesis-input-too-large"

export interface WikiErrorFields {
  readonly code: WikiErrorCode
  readonly message: string
  readonly topic?: string
  readonly path?: string
  readonly field?: string
}

/**
 * A typed wiki failure. Wiki generation is read-only; every failure leaves the
 * note root untouched.
 */
export class WikiError extends Data.TaggedError("WikiError")<WikiErrorFields> {}

export const wikiError = (fields: WikiErrorFields): WikiError =>
  new WikiError(fields)
