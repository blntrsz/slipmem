import { markdownError } from "@slipmem/core"
import { Effect, Option } from "effect"
import { join } from "node:path"
import { stringOption } from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { writeNoteHuman } from "../note-output.js"
import { noteToJson } from "../note-values.js"
import { writeJson } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const showCommand: CommandDefinition = {
  name: "show",
  summary: "Print one note with metadata, body, and file path",
  usage: "show <id> [--json]",
  minPositionals: 1,
  maxPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const id = parsed.positionals[0]!
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const note = yield* repository.get(id)

      if (Option.isNone(note)) {
        return yield* Effect.fail(
          markdownError({
            area: "repository",
            code: "not-found",
            path: join(resolved.root, `${id}.md`),
            message: `Note '${id}' was not found in ${resolved.root}.`,
          }),
        )
      }

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          note: noteToJson(resolved.root, note.value),
        })
      } else {
        writeNoteHuman(context.io, resolved.root, note.value)
      }

      return 0
    }),
}
