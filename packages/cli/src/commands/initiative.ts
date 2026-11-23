import { Effect } from "effect"
import { usageError } from "../errors.js"
import { runInitiativeCli } from "../initiative-cli.js"
import type { CommandDefinition } from "./command.js"

/**
 * The initiative subcommands keep their own strict parser and help text, so the
 * dispatcher routes raw argv to `runInitiativeCli` (see `runCli`). This
 * definition exists for top-level help and for a direct `CommandRunner` call.
 */
export const initiativeCommand: CommandDefinition = {
  name: "initiative",
  summary:
    "Manage durable initiative scope, milestones, evidence checks, and promotion",
  usage:
    "initiative <create|list|show|scope|verify|promote|project|reconcile|pin|milestone|assertion> [options]",
  details: [
    "Records live under .slipmem/initiatives/ and are never notes, search-index",
    "entries, recall candidates, or approval proposals. Verification is advisory",
    "and promotion is one clearly supported assertion at a time, after its",
    "evidence is reachable from the configured main ref. A landed promotion can",
    "be projected into one permanent note; projection is explicit and idempotent.",
    "Run 'slipmem initiative help' for subcommand options.",
  ],
  allowRest: true,
  minPositionals: 0,
  maxPositionals: 0,
  options: {},
  run: (_parsed, context) =>
    Effect.tryPromise({
      try: () => runInitiativeCli([], context),
      catch: (cause) =>
        usageError(
          `Could not run the initiative CLI: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          "initiative",
        ),
    }),
}
