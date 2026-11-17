import { Effect } from "effect"
import { stringOption } from "../args.js"
import { withApprovalService } from "../approval-access.js"
import { resolveRoot } from "../context.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const rejectCommand: CommandDefinition = {
  name: "reject",
  summary: "Discard a pending proposal without touching any note",
  usage: "reject <proposal-id> [--json]",
  details: [
    "Rejection is a human-only action. It removes only the proposal record;",
    "the current note, if any, is left exactly as it is.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      const proposalId = parsed.positionals[0]!
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const rejection = yield* withApprovalService(
        context,
        resolved.root,
        (service) => service.reject(proposalId),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          rejection,
        })
      } else {
        writeLine(context.io, `Rejected ${rejection.proposalId}. No notes changed.`)
      }
      return 0
    }),
}
