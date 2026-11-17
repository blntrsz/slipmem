import { Effect } from "effect"
import { stringOption } from "../args.js"
import { withApprovalService } from "../approval-access.js"
import { resolveRoot } from "../context.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const reviewCommand: CommandDefinition = {
  name: "review",
  summary: "List pending agent proposals with summaries, diffs, and stale state",
  usage: "review [--json]",
  details: [
    "Review is a human-only surface. It never applies a proposal and expires",
    "stale proposals according to the shared approval store policy.",
  ],
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const report = yield* withApprovalService(
        context,
        resolved.root,
        (service) => service.review(),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          pending: report.proposals.length,
          report,
        })
        return 0
      }

      writeLine(
        context.io,
        `Pending proposals: ${report.proposals.length} (${resolved.root})`,
      )
      if (report.removed.length > 0) {
        writeLine(
          context.io,
          `Expired proposals removed: ${report.removed.join(", ")}`,
        )
      }
      if (report.invalid.length > 0) {
        writeLine(context.io, `\nInvalid proposal files: ${report.invalid.length}`)
        for (const issue of report.invalid) {
          writeLine(context.io, `  - ${issue.code}: ${issue.message}`)
          if (issue.path !== undefined) {
            writeLine(context.io, `    ${issue.path}`)
          }
        }
      }

      for (const item of report.proposals) {
        const proposal = item.proposal
        const flags = [
          item.stale ? "STALE" : null,
          item.expired ? "EXPIRED" : null,
        ].filter((flag) => flag !== null)
        writeLine(
          context.io,
          `\n${proposal.id}  ${proposal.operation}  ${proposal.noteId ?? "(new note)"}${flags.length === 0 ? "" : `  [${flags.join(", ")}]`}`,
        )
        writeLine(context.io, `  ${item.summary}`)
        writeLine(
          context.io,
          `  actor: ${proposal.actor ?? "unknown"}, source: ${proposal.source}, created: ${proposal.createdAt}, expires: ${proposal.expiresAt}`,
        )
        if (item.diff.length > 0) {
          writeLine(context.io, "  diff:")
          for (const line of item.diff.split("\n")) {
            writeLine(context.io, `    ${line}`)
          }
        }
      }

      if (report.proposals.length === 0) {
        writeLine(context.io, "\nNo pending proposals.")
      }
      return 0
    }),
}
