import {
  atomicWriteFile,
  isPathInside,
  makeWikiService,
} from "@slipmem/core"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { parseAgentCommand } from "../agent-command.js"
import {
  booleanOption,
  listOption,
  numberOption,
  stringOption,
} from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { usageError } from "../errors.js"
import { parseLimit } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

const topicFrom = (positionals: ReadonlyArray<string>): string => {
  const topic = positionals.join(" ").trim()
  if (topic.length === 0) {
    throw usageError("wiki requires a non-empty topic.", "wiki")
  }
  return topic
}

const realPathOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Resolves the output file through its real parent directory. A symlinked
 * parent or an existing symlink target inside the note root is rejected before
 * any write, so `--out` cannot become a second note source through indirection.
 */
const outputPathFor = (
  cwd: string,
  root: string,
  out: string,
): string => {
  const candidate = resolve(cwd, out)
  const parent = dirname(candidate)
  if (!existsSync(parent)) {
    throw usageError(
      `--out directory does not exist: ${parent}. Create it first or choose an existing directory; the wiki never creates a second note root.`,
      "wiki",
    )
  }

  const realRoot = realPathOrUndefined(root)
  if (realRoot === undefined) {
    throw usageError(
      `Could not resolve the note root at ${root}; check that it still exists and is not a broken symlink.`,
      "wiki",
    )
  }
  const realParent = realPathOrUndefined(parent)
  if (realParent === undefined) {
    throw usageError(
      `Could not resolve the parent directory of --out at ${parent}; it may be a broken symlink.`,
      "wiki",
    )
  }

  const target = join(realParent, basename(candidate))
  if (isPathInside(target, realRoot)) {
    throw usageError(
      "--out must point outside the note root; a wiki page is never a persisted note.",
      "wiki",
    )
  }

  // An existing symlink is replaced by the atomic rename rather than followed,
  // but a link into the note root is still an ambiguous request. Reject it
  // instead of silently replacing the operator's indirection.
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    const linked = realPathOrUndefined(candidate)
    if (linked !== undefined && isPathInside(linked, realRoot)) {
      throw usageError(
        "--out is a symlink into the note root. Choose a regular path outside the root; the wiki does not write through note-root symlinks.",
        "wiki",
      )
    }
  }

  return candidate
}

interface WikiSynthesisConfig {
  readonly mode: Markdown.WikiMode
  readonly env: Readonly<Record<string, string | undefined>>
}

const synthesisConfig = (
  contextEnv: Readonly<Record<string, string | undefined>>,
  requestedMode: string | undefined,
  model: string | undefined,
  agent: string | undefined,
  agentArgs: ReadonlyArray<string>,
): WikiSynthesisConfig => {
  if (model !== undefined && agent !== undefined) {
    throw usageError(
      "--model and --agent are mutually exclusive; choose one local synthesizer.",
      "wiki",
    )
  }
  if (requestedMode !== undefined && requestedMode !== "extractive" && requestedMode !== "synthesized") {
    throw usageError(
      `--mode must be extractive or synthesized, not '${requestedMode}'.`,
      "wiki",
    )
  }
  if (requestedMode === "extractive" && (model !== undefined || agent !== undefined)) {
    throw usageError(
      "--mode extractive cannot be combined with --model or --agent. Drop the synthesizer option or request --mode synthesized.",
      "wiki",
    )
  }

  const envRaw = contextEnv.SLIPMEM_WIKI_SYNTHESIS?.trim()
  const envSynthesized =
    envRaw !== undefined && envRaw !== "" && envRaw !== "extractive"
  const mode: Markdown.WikiMode =
    requestedMode ??
    (model !== undefined || agent !== undefined || envSynthesized
      ? "synthesized"
      : "extractive")

  if (model !== undefined) {
    const modelId = model.trim()
    if (modelId === "") {
      throw usageError("--model requires a non-empty model ID.", "wiki")
    }
    if (modelId === "extractive" || modelId === "agent") {
      throw usageError(
        `--model must be a model ID, not '${modelId}'. Use --mode extractive for the fallback or --agent for a local process.`,
        "wiki",
      )
    }
    return {
      mode,
      env: {
        ...contextEnv,
        SLIPMEM_WIKI_SYNTHESIS: modelId,
        SLIPMEM_WIKI_AGENT: undefined,
        SLIPMEM_WIKI_AGENT_ARGS: undefined,
      },
    }
  }

  if (agent !== undefined) {
    const parsed = parseAgentCommand(agent)
    const args = [...parsed.args, ...agentArgs]
    return {
      mode,
      env: {
        ...contextEnv,
        SLIPMEM_WIKI_SYNTHESIS: "agent",
        SLIPMEM_WIKI_AGENT: parsed.command,
        SLIPMEM_WIKI_AGENT_ARGS: JSON.stringify(args),
      },
    }
  }

  // An explicit extractive request must not be overridden by a stale
  // synthesizer environment. Otherwise let the shared core resolve the env.
  return {
    mode,
    env:
      requestedMode === "extractive"
        ? { ...contextEnv, SLIPMEM_WIKI_SYNTHESIS: "extractive" }
        : contextEnv,
  }
}

export const wikiCommand: CommandDefinition = {
  name: "wiki",
  summary:
    "Generate a cited topic page, extractive or with a configured local synthesizer",
  usage:
    "wiki <topic> [--limit <n>] [--mode extractive|synthesized] [--model <id> | --agent <command>] [--agent-arg <arg>...] [--include-fleeting] [--out <path>] [--json]",
  details: [
    "Selects permanent and literature notes whose topics or text match the",
    "normalized topic through the shared core WikiService, then quotes each",
    "selected note verbatim with its ID and file citation. Nothing is written",
    "under .slipmem/; stdout is the default.",
    "--agent is split into an argv array and run without a shell; the bounded",
    "notes arrive as JSON on stdin. The agent must print {\"sentences\":[...]}",
    "with an exact supporting quote per sentence. --model works only when the",
    "application registered an adapter for that exact ID.",
  ],
  options: {
    limit: { type: "number", valueName: "n" },
    mode: { type: "string", valueName: "extractive|synthesized" },
    model: { type: "string", valueName: "id" },
    agent: { type: "string", valueName: "command" },
    "agent-arg": { type: "list", valueName: "arg" },
    out: { type: "string", valueName: "path" },
    "include-fleeting": { type: "boolean" },
  },
  minPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const topic = topicFrom(parsed.positionals)
      const synthesis = synthesisConfig(
        context.env,
        stringOption(parsed, "mode"),
        stringOption(parsed, "model"),
        stringOption(parsed, "agent"),
        listOption(parsed, "agent-arg"),
      )

      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "wiki",
        fallback: Markdown.DEFAULT_WIKI_LIMIT,
        maximum: Markdown.MAX_WIKI_LIMIT,
      })
      const includeFleeting = booleanOption(parsed, "include-fleeting")
      const out = stringOption(parsed, "out")

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const service = yield* makeWikiService(repository, {
        now: context.now,
        env: synthesis.env,
        mode: synthesis.mode,
      })
      const page = yield* service.build({
        topic,
        limit,
        mode: synthesis.mode,
        includeFleeting,
      })

      let outputPath: string | undefined
      if (out !== undefined) {
        outputPath = outputPathFor(context.cwd, resolved.root, out)
        yield* atomicWriteFile(outputPath, page.markdown, { overwrite: true })
      }

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          ...(outputPath === undefined ? {} : { out: outputPath }),
          page,
        })
      } else if (outputPath !== undefined) {
        writeLine(
          context.io,
          `Wrote a cited page with ${page.noteCount} note${page.noteCount === 1 ? "" : "s"} to ${outputPath}`,
        )
      } else {
        context.io.out(`${page.markdown}\n`)
      }

      return 0
    }),
}
