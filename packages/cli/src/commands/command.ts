import type { MarkdownError, WikiError } from "@slipmem/core"
import type { Effect } from "effect"
import type { OptionSpec, ParsedArguments } from "../args.js"
import type { CliContext } from "../context.js"
import type { CliFailure } from "../errors.js"

export type CommandError = CliFailure | MarkdownError | WikiError

export type CommandRunner = (
  parsed: ParsedArguments,
  context: CliContext,
) => Effect.Effect<number, CommandError>

export interface CommandDefinition {
  readonly name: string
  readonly summary: string
  readonly usage: string
  readonly details?: ReadonlyArray<string>
  readonly options?: Readonly<Record<string, OptionSpec>>
  readonly minPositionals?: number
  readonly maxPositionals?: number
  readonly allowRest?: boolean
  readonly run: CommandRunner
}
