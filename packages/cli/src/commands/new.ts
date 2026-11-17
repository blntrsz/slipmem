import { Effect } from "effect"
import {
  listOption,
  requireStringOption,
  stringOption,
} from "../args.js"
import { openRepository, resolveRoot, type CliContext } from "../context.js"
import { usageError } from "../errors.js"
import { ensureEditor, readDraft, withTempDraft } from "../editor.js"
import { requireNoteType, topicValues, noteToJson } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

const actor = (context: CliContext): string => {
  const configured = context.env.SLIPMEM_ACTOR?.trim()
  return configured === undefined || configured.length === 0 ? "user" : configured
}

export const newCommand: CommandDefinition = {
  name: "new",
  summary: "Create a fleeting, permanent, or literature note",
  usage:
    "new --type <fleeting|permanent|literature> --title <title> [content source] [options]",
  details: [
    "Content comes from --content, non-interactive stdin, or an editor draft",
    "opened with SLIPMEM_EDITOR, VISUAL, or EDITOR. Human writes are direct.",
    "Repeat --topic for multiple topics; comma-separated values also work.",
  ],
  options: {
    type: { type: "string", valueName: "type" },
    title: { type: "string", valueName: "title" },
    content: { type: "string", valueName: "text" },
    topic: { type: "list", valueName: "topic" },
    topics: { type: "list", valueName: "topic" },
    reference: { type: "string", valueName: "source" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const type = requireNoteType(stringOption(parsed, "type"), "new")
      const title = requireStringOption(parsed, "title", "new")
      const reference = stringOption(parsed, "reference")
      const topics = topicValues([
        ...listOption(parsed, "topic"),
        ...listOption(parsed, "topics"),
      ])

      let content = stringOption(parsed, "content")
      if (content === undefined) {
        if (!context.stdinIsTTY) {
          content = yield* Effect.tryPromise({
            try: () => context.readStdin(),
            catch: (cause) =>
              usageError(
                `Could not read note content from stdin: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          })
        } else {
          yield* ensureEditor(context)
          content = yield* withTempDraft("body.md", "", context, (path) =>
            readDraft(path),
          )
        }
      }

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const note = yield* repository.create({
        type,
        title,
        content,
        ...(topics.length === 0 ? {} : { topics }),
        ...(reference === undefined ? {} : { reference }),
        provenance: { source: "cli", actor: actor(context) },
      })

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          note: noteToJson(resolved.root, note),
        })
      } else {
        writeLine(
          context.io,
          `Created ${note.metadata.type} note ${note.id}`,
        )
        writeLine(context.io, `  ${note.path}`)
      }

      return 0
    }),
}
