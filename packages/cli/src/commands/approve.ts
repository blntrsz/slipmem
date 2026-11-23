import { Effect } from "effect"
import { stringOption } from "../args.js"
import { withApprovalService } from "../approval-access.js"
import { resolveRoot } from "../context.js"
import { noteToJson } from "../note-values.js"
import { writeErrorLine, writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const approveCommand: CommandDefinition = {
  name: "approve",
  summary: "Apply a pending proposal after revalidating its base hash",
  usage: "approve <proposal-id> [--json]",
  details: [
    "Approval is a human-only action and is never exposed through MCP.",
    "A stale base hash, expired proposal, or invalid target fails without",
    "writing or deleting a note.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      const proposalId = parsed.positionals[0]!
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const application = yield* withApprovalService(
        context,
        resolved.root,
        (service) => service.apply(proposalId),
        { refreshIndex: true },
      )

      const writeWarnings = (): void => {
        if (application.index.warning !== undefined) {
          writeErrorLine(context.io, `Warning: ${application.index.warning}`)
        }
        if (application.cleanup?.warning !== undefined) {
          writeErrorLine(context.io, `Warning: ${application.cleanup.warning}`)
        }
      }

      if (parsed.options.json === true) {
        writeWarnings()
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          application:
            application.operation === "delete"
              ? {
                  status: application.status,
                  proposalId: application.proposalId,
                  operation: application.operation,
                  noteId: application.noteId,
                  backupPath: application.backupPath,
                  index: application.index,
                  ...(application.cleanup === undefined
                    ? {}
                    : { cleanup: application.cleanup }),
                }
              : {
                  status: application.status,
                  proposalId: application.proposalId,
                  operation: application.operation,
                  noteId: application.noteId,
                  note: noteToJson(resolved.root, application.note),
                  index: application.index,
                  ...(application.cleanup === undefined
                    ? {}
                    : { cleanup: application.cleanup }),
                },
        })
        return 0
      }

      if (application.operation === "delete") {
        writeLine(
          context.io,
          `Approved ${proposalId}: moved ${application.noteId} to ${application.backupPath}`,
        )
      } else {
        writeLine(
          context.io,
          `Approved ${proposalId}: ${application.operation} ${application.noteId}`,
        )
        writeLine(context.io, `  ${application.note.path}`)
      }
      writeWarnings()
      return 0
    }),
}
