import { Effect } from "effect"
import { numberOption, stringOption } from "../args.js"
import { resolveRoot } from "../context.js"
import { withSearchIndex } from "../index-access.js"
import { parseLimit } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const tagsCommand: CommandDefinition = {
  name: "tags",
  summary: "List tag slugs and note counts",
  usage: "tags [--query <tag>] [--limit <n>] [--json]",
  options: {
    query: { type: "string", valueName: "tag" },
    limit: { type: "number", valueName: "n" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "tags",
        fallback: 50,
        maximum: 200,
      })
      const query = stringOption(parsed, "query")
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const result = yield* withSearchIndex(context, resolved.root, (index) =>
        Effect.gen(function* () {
          yield* index.refresh()
          const tags = yield* index.listTags({
            limit,
            ...(query === undefined ? {} : { query }),
          })
          return { tags, mode: index.mode }
        }),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          count: result.tags.length,
          index: result.mode,
          tags: result.tags,
        })
      } else if (result.tags.length === 0) {
        writeLine(context.io, "No tags.")
      } else {
        const width = Math.max(5, ...result.tags.map((tag) => tag.tag.length))
        writeLine(context.io, `${"TAG".padEnd(width)}  NOTES`)
        for (const tag of result.tags) {
          writeLine(
            context.io,
            `${tag.tag.padEnd(width)}  ${tag.noteCount}`,
          )
        }
      }

      return 0
    }),
}
