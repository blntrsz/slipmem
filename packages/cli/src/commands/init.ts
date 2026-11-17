import { initializeNoteRoot } from "@slipmem/core"
import { Effect } from "effect"
import { stringOption } from "../args.js"
import { resolveRoot } from "../context.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const initCommand: CommandDefinition = {
  name: "init",
  summary: "Create .slipmem/ with local state and a starter README (idempotent)",
  usage: "init [--json] [--dir <path>]",
  details: [
    "Without --dir, the root is SLIPMEM_DIR if set, otherwise .slipmem/",
    "at the Git root (or the current directory when there is no Git root).",
  ],
  run: (parsed, context) =>
    Effect.gen(function* () {
      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"), true)
      const initialized = yield* initializeNoteRoot(resolved.root)

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: initialized.root,
          created: initialized.created,
          stateDir: initialized.stateDir,
          readmePath: initialized.readmePath,
          source: resolved.source,
        })
      } else {
        writeLine(
          context.io,
          initialized.created
            ? `Initialized slipmem repository at ${initialized.root}`
            : `slipmem repository is already available at ${initialized.root}`,
        )
        writeLine(context.io, `  state:  ${initialized.stateDir}`)
        writeLine(context.io, `  readme: ${initialized.readmePath}`)
      }

      return 0
    }),
}
