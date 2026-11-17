import { Effect } from "effect"
import { numberOption, stringOption } from "../args.js"
import { resolveRoot } from "../context.js"
import { withSearchIndex } from "../index-access.js"
import { parseLimit } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const topicsCommand: CommandDefinition = {
  name: "topics",
  summary: "List topic slugs and note counts",
  usage: "topics [--query <topic>] [--limit <n>] [--json]",
  options: {
    query: { type: "string", valueName: "topic" },
    limit: { type: "number", valueName: "n" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "topics",
        fallback: 50,
        maximum: 200,
      })
      const query = stringOption(parsed, "query")
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const result = yield* withSearchIndex(context, resolved.root, (index) =>
        Effect.gen(function* () {
          yield* index.refresh()
          const topics = yield* index.listTopics({
            limit,
            ...(query === undefined ? {} : { query }),
          })
          return { topics, mode: index.mode }
        }),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          count: result.topics.length,
          index: result.mode,
          topics: result.topics,
        })
      } else if (result.topics.length === 0) {
        writeLine(context.io, "No topics.")
      } else {
        const width = Math.max(5, ...result.topics.map((topic) => topic.topic.length))
        writeLine(context.io, `${"TOPIC".padEnd(width)}  NOTES`)
        for (const topic of result.topics) {
          writeLine(
            context.io,
            `${topic.topic.padEnd(width)}  ${topic.noteCount}`,
          )
        }
      }

      return 0
    }),
}
