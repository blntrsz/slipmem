import { Data } from "effect"

/**
 * A command line contract failure: unknown option, missing value, wrong
 * positional count, or a locally invalid value. These are user errors and exit
 * with status 2, distinct from note validation failures (status 1).
 */
export class CliUsageError extends Data.TaggedError("CliUsageError")<{
  readonly message: string
  readonly command?: string
}> {}

export const usageError = (
  message: string,
  command?: string,
): CliUsageError =>
  new CliUsageError(command === undefined ? { message } : { message, command })

/**
 * An explicit not-yet-implemented boundary. The shared CLI never fakes a
 * successful write or migration when the core API is absent.
 */
export class CliUnavailableError extends Data.TaggedError("CliUnavailableError")<{
  readonly message: string
  readonly feature: string
  readonly code: string
}> {}

export const unavailable = (
  feature: string,
  message: string,
  code = "not-implemented",
): CliUnavailableError =>
  new CliUnavailableError({ feature, message, code })

export type CliFailure = CliUsageError | CliUnavailableError
