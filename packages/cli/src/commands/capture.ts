import { Effect } from "effect"
import { booleanOption, requireStringOption, stringOption } from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { usageError } from "../errors.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"
import { runGitCapture } from "../capture/run.js"

const shortSha = (sha: string): string => sha.slice(0, 12)

export const captureCommand: CommandDefinition = {
  name: "capture",
  summary: "Capture a verified main-push Git delta as fleeting memory sources",
  usage:
    "capture git --before <sha> --after <sha> [--repo <path>] [options]",
  details: [
    "Reads only Git objects. It verifies exact commit SHAs, HEAD == --after, and",
    "that after descends from before; it never checks out, fetches, resets, or",
    "writes to the source checkout.",
    "Requires an explicit tool-less OpenAI-compatible chat provider via",
    "SLIPMEM_CAPTURE_PROVIDER=openai-compatible, SLIPMEM_CAPTURE_MODEL, and",
    "SLIPMEM_CAPTURE_BASE_URL, or the shared SLIPMEM_CHAT_* configuration with",
    "the same provider/model/base URL. API keys belong in the environment, not argv.",
    "Writes idempotent fleeting notes plus a note-root checkpoint. Consolidation",
    "is left to the configured memory runtime unless --consolidate is given; that",
    "flag is rejected while a live runtime consolidation lease exists.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {
    before: { type: "string", valueName: "sha" },
    after: { type: "string", valueName: "sha" },
    repo: { type: "string", valueName: "path" },
    consolidate: { type: "boolean" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const target = parsed.positionals[0]!
      if (target !== "git") {
        return yield* Effect.fail(
          usageError(
            `capture supports only 'git', not '${target}'.`,
            "capture",
          ),
        )
      }

      const before = requireStringOption(parsed, "before", "capture")
      const after = requireStringOption(parsed, "after", "capture")
      const repositoryPath = stringOption(parsed, "repo") ?? context.cwd
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)

      const result = yield* runGitCapture({
        repository,
        repositoryPath,
        noteRoot: resolved.root,
        before,
        after,
        consolidate: booleanOption(parsed, "consolidate"),
        env: context.env,
        now: context.now,
      })

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          ...result,
        })
        return 0
      }

      if (result.reason === "no-changes") {
        writeLine(
          context.io,
          `No changes between ${shortSha(before)} and ${shortSha(after)}; checkpoint updated.`,
        )
      } else if (result.reason === "no-capturable-hunks") {
        writeLine(
          context.io,
          `No capturable text hunks between ${shortSha(before)} and ${shortSha(after)}; checkpoint updated.`,
        )
      } else {
        writeLine(
          context.io,
          `Captured ${result.sources.length} fleeting source${result.sources.length === 1 ? "" : "s"} from ${shortSha(before)}..${shortSha(after)}.`,
        )
        for (const source of result.sources) {
          writeLine(
            context.io,
            `  ${source.created ? "created" : "existing"} ${source.id}  ${source.title}`,
          )
        }
      }

      if (result.skipped.length > 0) {
        writeLine(context.io, `  skipped ${result.skipped.length} model source(s):`)
        for (const skip of result.skipped) {
          writeLine(
            context.io,
            `    - ${skip.reason}${skip.title === undefined ? "" : ` (${skip.title})`}`,
          )
        }
      }
      if (result.diff.omittedCount > 0) {
        writeLine(
          context.io,
          `  omitted ${result.diff.omittedCount} file(s) from model input${result.diff.omittedCount > result.diff.omitted.length ? ` (showing ${result.diff.omitted.length})` : ""}:`,
        )
        for (const file of result.diff.omitted) {
          writeLine(context.io, `    - ${file.path}: ${file.reason}`)
        }
      }

      writeLine(context.io, `  checkpoint: ${result.checkpointPath} (${result.checkpointStatus})`)
      if (result.model.called) {
        const egress =
          result.model.egress === "remote"
            ? "remote; bounded diff content left this machine"
            : "local loopback"
        writeLine(context.io, `  model: ${result.model.label ?? "configured provider"} (${egress})`)
      }
      if (result.consolidation.requested) {
        writeLine(
          context.io,
          `  consolidation: ${result.consolidation.status}; writes ${result.consolidation.writes}, pending sources ${result.consolidation.pendingSourceCount}`,
        )
      } else {
        writeLine(
          context.io,
          "  consolidation: left to the configured runtime; durable sources are available for its next scan.",
        )
      }
      for (const warning of result.warnings) {
        writeLine(context.io, `  warning: ${warning}`)
      }

      return 0
    }),
}
