import {
  atomicWriteFile,
  isPathInside,
} from "@slipmem/core"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { resolve } from "node:path"
import {
  booleanOption,
  numberOption,
  stringOption,
} from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { CliUsageError, unavailable, usageError } from "../errors.js"
import { parseLimit } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import { buildExtractiveWiki } from "../wiki.js"
import type { CommandDefinition } from "./command.js"

const topicFrom = (positionals: ReadonlyArray<string>): string => {
  const topic = positionals.join(" ").trim()
  if (topic.length === 0) {
    throw usageError("wiki requires a non-empty topic.", "wiki")
  }
  return topic
}

export const wikiCommand: CommandDefinition = {
  name: "wiki",
  summary: "Generate a cited topic page on demand (basic extractive mode)",
  usage:
    "wiki <topic> [--limit <n>] [--mode extractive] [--include-fleeting] [--out <path>] [--json]",
  details: [
    "Selects permanent and literature notes whose topics or text match the",
    "normalized topic, then quotes each selected note verbatim with its ID and",
    "file citation. Nothing is written under .slipmem/; stdout is the default.",
    "Synthesized mode requires the core citation validator and is reported as",
    "unavailable rather than silently downgraded.",
  ],
  options: {
    limit: { type: "number", valueName: "n" },
    mode: { type: "string", valueName: "extractive" },
    model: { type: "string", valueName: "id" },
    agent: { type: "string", valueName: "command" },
    out: { type: "string", valueName: "path" },
    "include-fleeting": { type: "boolean" },
  },
  minPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const topic = topicFrom(parsed.positionals)
      const mode = stringOption(parsed, "mode") ?? "extractive"
      const model = stringOption(parsed, "model")
      const agent = stringOption(parsed, "agent")

      if (mode !== "extractive" && mode !== "synthesized") {
        return yield* Effect.fail(
          usageError(
            `--mode must be extractive or synthesized, not '${mode}'.`,
            "wiki",
          ),
        )
      }
      if (mode === "synthesized" || model !== undefined || agent !== undefined) {
        return yield* Effect.fail(
          unavailable(
            "wiki-synthesis",
            "Synthesized wiki generation is not available in this build. Use --mode extractive; the citation-validated synthesizer is a later phase and no page was written.",
            "synthesis-unavailable",
          ),
        )
      }

      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "wiki",
        fallback: Markdown.DEFAULT_WIKI_LIMIT,
        maximum: Markdown.MAX_WIKI_LIMIT,
      })
      const includeFleeting = booleanOption(parsed, "include-fleeting")
      const out = stringOption(parsed, "out")

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const scan = yield* repository.scan()
      const result = yield* Effect.try({
        try: () =>
          buildExtractiveWiki({
            root: resolved.root,
            topic,
            notes: scan.notes,
            limit,
            includeFleeting,
            nowMs: context.now(),
          }),
        catch: (cause) =>
          cause instanceof CliUsageError
            ? cause
            : usageError(
                cause instanceof Error ? cause.message : String(cause),
                "wiki",
              ),
      })

      let outputPath: string | undefined
      if (out !== undefined) {
        outputPath = resolve(context.cwd, out)
        if (isPathInside(outputPath, resolved.root)) {
          return yield* Effect.fail(
            usageError(
              "--out must point outside the note root; a wiki page is never a persisted note.",
              "wiki",
            ),
          )
        }
        yield* atomicWriteFile(outputPath, result.markdown, { overwrite: true })
      }

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          ...(outputPath === undefined ? {} : { out: outputPath }),
          page: result.page,
        })
      } else if (outputPath !== undefined) {
        writeLine(
          context.io,
          `Wrote a cited page with ${result.page.noteCount} note${result.page.noteCount === 1 ? "" : "s"} to ${outputPath}`,
        )
      } else {
        context.io.out(result.markdown)
      }

      return 0
    }),
}
