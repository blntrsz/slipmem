import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { numberOption, stringOption } from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { writeNoteListHuman } from "../note-output.js"
import { noteToJson, parseLimit, parseNoteType } from "../note-values.js"
import { writeJson } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const listCommand: CommandDefinition = {
  name: "list",
  summary: "List notes with bounded type and topic filters",
  usage: "list [--type <type>] [--topic <topic>] [--limit <n>] [--json]",
  options: {
    type: { type: "string", valueName: "type" },
    topic: { type: "string", valueName: "topic" },
    limit: { type: "number", valueName: "n" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const type = parseNoteType(stringOption(parsed, "type"), "list")
      const topic = stringOption(parsed, "topic")
      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "list",
        fallback: Markdown.DEFAULT_SEARCH_LIMIT,
      })

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const notes = yield* repository.listNotes({
        limit,
        ...(type === undefined ? {} : { type }),
        ...(topic === undefined ? {} : { topic }),
      })

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          count: notes.length,
          limit,
          notes: notes.map((note) => noteToJson(resolved.root, note)),
        })
      } else {
        writeNoteListHuman(context.io, resolved.root, notes)
      }

      return 0
    }),
}
