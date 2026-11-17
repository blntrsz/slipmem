import { checkNoteRoot, indexExists } from "@slipmem/core"
import { Effect } from "effect"
import { booleanOption, stringOption } from "../args.js"
import { indexConfig, resolveRoot } from "../context.js"
import { withSearchIndex } from "../index-access.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const checkCommand: CommandDefinition = {
  name: "check",
  summary: "Validate note filenames, metadata, limits, links, and index drift",
  usage: "check [--rebuild-index] [--json]",
  details: [
    "Errors make the command exit 1. Warnings, non-note files, and slug drift",
    "are reported but do not fail. check never renames or repairs a note.",
  ],
  options: {
    "rebuild-index": { type: "boolean" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const rebuild = booleanOption(parsed, "rebuild-index")
      const config = indexConfig(context, resolved.root)
      const hasIndex = indexExists(config)

      let indexInfo:
        | {
            readonly mode: string
            readonly path: string
            readonly noteCount: number
            readonly rebuilt: boolean
          }
        | undefined
      let fingerprints:
        | ReadonlyArray<{ readonly id: string; readonly contentHash: string }>
        | undefined

      if (rebuild || hasIndex) {
        const inspected = yield* withSearchIndex(context, resolved.root, (index) =>
          Effect.gen(function* () {
            if (rebuild) {
              yield* index.rebuild()
            }
            const status = yield* index.status()
            const snapshot = yield* index.snapshot()
            return {
              status,
              snapshot,
            }
          }),
        )
        indexInfo = {
          mode: inspected.status.mode,
          path: inspected.status.path,
          noteCount: inspected.status.noteCount,
          rebuilt: rebuild,
        }
        fingerprints = inspected.snapshot.map((entry) => ({
          id: entry.id,
          contentHash: entry.contentHash,
        }))
      }

      const report = yield* checkNoteRoot(
        resolved.root,
        fingerprints === undefined ? {} : { index: fingerprints },
      )
      const ok = report.ok

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok,
          root: report.root,
          report,
          ...(indexInfo === undefined ? {} : { index: indexInfo }),
        })
      } else {
        writeLine(context.io, `Checked ${report.root}`)
        writeLine(
          context.io,
          `  notes: ${report.noteCount}, files scanned: ${report.scannedFiles}, errors: ${report.issues.length}, warnings: ${report.warnings.length}`,
        )
        if (indexInfo !== undefined) {
          writeLine(
            context.io,
            `  index: ${indexInfo.rebuilt ? "rebuilt" : "checked"} (${indexInfo.mode}), ${indexInfo.noteCount} notes, ${report.index.drift} drift`,
          )
          writeLine(context.io, `  index path: ${indexInfo.path}`)
        } else {
          writeLine(context.io, "  index: not present (rebuild is optional)")
        }

        if (report.issues.length > 0) {
          writeLine(context.io, "\nErrors:")
          for (const issue of report.issues) {
            writeLine(
              context.io,
              `  - ${issue.code}${issue.field === undefined ? "" : ` (${issue.field})`}: ${issue.message}`,
            )
            writeLine(context.io, `    ${issue.path}`)
          }
        }
        if (report.warnings.length > 0) {
          writeLine(context.io, "\nWarnings:")
          for (const warning of report.warnings) {
            writeLine(
              context.io,
              `  - ${warning.code}: ${warning.message}`,
            )
            writeLine(context.io, `    ${warning.path}`)
          }
        }
        writeLine(context.io, ok ? "\nOK" : "\nFailed")
      }

      return ok ? 0 : 1
    }),
}
