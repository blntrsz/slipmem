import { Markdown } from "@slipmem/schemas/markdown"
import {
  MAX_SEARCH_QUERY_LENGTH,
  type MarkdownSearchHit,
} from "@slipmem/core"
import { Effect } from "effect"
import { numberOption, stringOption } from "../args.js"
import { resolveRoot } from "../context.js"
import { usageError } from "../errors.js"
import { makeExcerpt } from "../excerpt.js"
import { withSearchIndex } from "../index-access.js"
import { citationPath, parseLimit, parseNoteType } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

const queryFrom = (positionals: ReadonlyArray<string>): string => {
  const query = positionals.join(" ").trim()
  if (query.length === 0) {
    throw usageError("search requires a non-empty query.", "search")
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw usageError(
      `Search queries must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer.`,
      "search",
    )
  }
  return query
}

const resultJson = (
  root: string,
  hit: MarkdownSearchHit,
  query: string,
): Record<string, unknown> => ({
  id: hit.id,
  path: hit.path,
  citation: citationPath(root, hit.path.split(/[\\/]/).pop() ?? hit.id),
  type: hit.note.type,
  title: hit.note.title,
  updatedAt: Markdown.toUtcTimestamp(hit.note.updatedAt).isoTimestamp,
  score: hit.score,
  excerpt: makeExcerpt(hit.note.content, query),
})

export const searchCommand: CommandDefinition = {
  name: "search",
  summary: "Ranked, bounded search across note titles, topics, and bodies",
  usage: "search <query> [--type <type>] [--topic <topic>] [--limit <n>] [--json]",
  details: [
    "The query may be unquoted when it contains no option-like tokens.",
    "Search refreshes the disposable index first, so external edits are visible.",
  ],
  options: {
    type: { type: "string", valueName: "type" },
    topic: { type: "string", valueName: "topic" },
    limit: { type: "number", valueName: "n" },
  },
  minPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const query = queryFrom(parsed.positionals)
      const type = parseNoteType(stringOption(parsed, "type"), "search")
      const topic = stringOption(parsed, "topic")
      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "search",
        fallback: Markdown.DEFAULT_SEARCH_LIMIT,
      })

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const result = yield* withSearchIndex(context, resolved.root, (index) =>
        Effect.gen(function* () {
          yield* index.refresh()
          const hits = yield* index.search({
            query,
            limit,
            ...(type === undefined ? {} : { kinds: [type] }),
            ...(topic === undefined ? {} : { topic }),
          })
          return { hits, mode: index.mode, path: index.path }
        }),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          query,
          count: result.hits.length,
          limit,
          index: {
            mode: result.mode,
            path: result.path,
          },
          results: result.hits.map((hit) =>
            resultJson(resolved.root, hit, query),
          ),
        })
      } else if (result.hits.length === 0) {
        writeLine(context.io, `No matches for '${query}'.`)
      } else {
        result.hits.forEach((hit, index) => {
          if (index > 0) {
            writeLine(context.io)
          }
          writeLine(
            context.io,
            `${hit.id}  [${hit.note.type}]  ${hit.note.title}`,
          )
          writeLine(
            context.io,
            `  ${makeExcerpt(hit.note.content, query)}`,
          )
        })
        writeLine(
          context.io,
          `\n${result.hits.length} result${result.hits.length === 1 ? "" : "s"} (index: ${result.mode})`,
        )
      }

      return 0
    }),
}
