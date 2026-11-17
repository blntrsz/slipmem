import { markdownError } from "@slipmem/core"
import { Effect, Option } from "effect"
import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import { booleanOption, stringOption } from "../args.js"
import { openRepository, resolveRoot, type CliContext } from "../context.js"
import { usageError, CliUsageError } from "../errors.js"
import { noteToJson } from "../note-values.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

const confirmDelete = async (
  context: CliContext,
  id: string,
): Promise<boolean> => {
  if (!context.stdinIsTTY) {
    throw usageError(
      "Refusing to delete a note without --yes in a non-interactive session.",
      "delete",
    )
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await terminal.question(
      `Delete note ${id}? It will be moved to the trash backup. [y/N] `,
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    terminal.close()
  }
}

export const deleteCommand: CommandDefinition = {
  name: "delete",
  summary: "Move one note to the local trash backup after confirmation",
  usage: "delete <id> [--yes] [--json]",
  details: [
    "The note file is moved to the per-root trash directory outside .slipmem/.",
    "Non-interactive sessions must pass --yes; without it the command refuses",
    "before reading or removing the note.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {
    yes: { type: "boolean" },
  },
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

      if (booleanOption(parsed, "yes") !== true) {
        const confirmed = yield* Effect.tryPromise({
          try: () => confirmDelete(context, id),
          catch: (cause) =>
            cause instanceof CliUsageError
              ? cause
              : usageError(
                  cause instanceof Error ? cause.message : String(cause),
                  "delete",
                ),
        })
        if (!confirmed) {
          if (parsed.options.json === true) {
            writeJson(context.io, {
              ok: true,
              root: resolved.root,
              deleted: false,
              id,
            })
          } else {
            writeLine(context.io, "Aborted. No note was deleted.")
          }
          return 0
        }
      }

      const result = yield* repository.delete(id)
      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          deleted: true,
          id: result.id,
          note: noteToJson(resolved.root, result.note),
          backupPath: result.backupPath,
        })
      } else {
        writeLine(context.io, `Deleted ${result.id}`)
        writeLine(context.io, `  moved to ${result.backupPath}`)
      }
      return 0
    }),
}
