import {
  indexExists,
  isIndexCorruptionError,
  repairCorruptSearchIndex,
  repairSearchIndexCache,
} from "@slipmem/core"
import { Effect } from "effect"
import { stringOption } from "../args.js"
import { indexConfig, resolveRoot } from "../context.js"
import { usageError } from "../errors.js"
import { withSearchIndex } from "../index-access.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

export const cacheCommand: CommandDefinition = {
  name: "cache",
  summary: "Clear the disposable search index without touching notes",
  usage: "cache clear [--json]",
  details: [
    "Clears only the derived SQLite index through the shared core index API.",
    "A corrupt index file is removed and recreated empty. No note file, .state",
    "entry, or cache directory is removed. The next search, tags, or",
    "check --rebuild-index recreates the index from notes.",
  ],
  minPositionals: 1,
  maxPositionals: 1,
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      const action = parsed.positionals[0]!
      if (action !== "clear") {
        return yield* Effect.fail(
          usageError(
            `cache supports only 'clear', not '${action}'.`,
            "cache",
          ),
        )
      }

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const config = indexConfig(context, resolved.root)
      const existed = indexExists(config)
      // A damaged header is repaired from the filesystem before SQLite is
      // opened. This is the documented recovery command, so it must not fail on
      // the same corrupt file it is meant to remove.
      const initialRepair = yield* repairCorruptSearchIndex(config)
      let repaired = initialRepair.repaired

      const clearIndex = () =>
        withSearchIndex(context, resolved.root, (index) =>
          Effect.gen(function* () {
            const before = yield* index.status()
            yield* index.clear()
            const after = yield* index.status()
            return { before, after }
          }),
        )

      const result = yield* clearIndex().pipe(
        Effect.catch((error) => {
          if (!isIndexCorruptionError(error)) {
            return Effect.fail(error)
          }
          return Effect.gen(function* () {
            const repairedCache = yield* repairSearchIndexCache(config)
            repaired = repaired || repairedCache.removed
            return yield* clearIndex()
          })
        }),
      )

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          path: result.after.path,
          existed,
          repaired,
          clearedNotes: result.before.noteCount,
          noteCount: result.after.noteCount,
        })
      } else {
        writeLine(
          context.io,
          `Cleared the disposable search index at ${result.after.path}`,
        )
        writeLine(
          context.io,
          `  indexed notes: ${result.before.noteCount} -> ${result.after.noteCount}`,
        )
        if (repaired) {
          writeLine(
            context.io,
            "  repaired a corrupt index file; notes were not changed.",
          )
        }
        writeLine(
          context.io,
          "  note files were not changed; the next search or check --rebuild-index repopulates the index.",
        )
      }

      return 0
    }),
}
