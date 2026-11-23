import {
  getLegacyNote,
  LEGACY_READ_DEFAULT_LIMIT,
  LEGACY_READ_MAX_ID_LENGTH,
  LEGACY_READ_MAX_LIMIT,
  LEGACY_READ_MAX_OFFSET,
  listLegacyNotes,
  MigrationSourceError,
  type LegacyReadRow,
} from "@slipmem/core/legacy/migration"
import { Effect } from "effect"
import {
  numberOption,
  requireStringOption,
  stringOption,
} from "../args.js"
import { resolveSourceDatabasePath } from "../database-path.js"
import { migrationError, usageError, type CliFailure } from "../errors.js"
import { parseLimit, parseNoteType } from "../note-values.js"
import { writeJson, writeLine, type CliIo } from "../output.js"
import { toPortableJson } from "../portable-json.js"
import type { CommandDefinition } from "./command.js"

const READ_ONLY_WARNING =
  "Read-only one-release compatibility view of the retired SQLite database. Markdown under .slipmem/ remains the source of truth. This command never imports, repairs, deletes, or writes note files."

const readError = (cause: unknown): CliFailure => {
  if (cause instanceof RangeError) {
    return usageError(cause.message, "legacy")
  }
  if (cause instanceof MigrationSourceError) {
    return migrationError(
      `Could not read the legacy SQLite source read-only: ${cause.message}`,
      cause.code,
    )
  }
  return migrationError(
    `Could not read the legacy SQLite source read-only: ${cause instanceof Error ? cause.message : String(cause)}`,
    "legacy-read-failed",
  )
}

const writeWarning = (io: CliIo): void => {
  writeLine(io, `LEGACY READ-ONLY (one release): ${READ_ONLY_WARNING}`)
}

const offsetFrom = (value: number | undefined): number => {
  if (value === undefined) {
    return 0
  }
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > LEGACY_READ_MAX_OFFSET
  ) {
    throw usageError(
      `--offset must be an integer between 0 and ${LEGACY_READ_MAX_OFFSET}.`,
      "legacy",
    )
  }
  return value
}

const rowLabel = (row: LegacyReadRow): string =>
  `${row.type} ${row.legacyId ?? "<missing-id>"} [${row.valid ? "valid" : "invalid"}]`

const writeProblems = (io: CliIo, row: LegacyReadRow): void => {
  if (row.problems.length === 0) {
    return
  }
  writeLine(io, "  problems:")
  for (const problem of row.problems) {
    writeLine(io, `    - ${problem.severity} ${problem.code}: ${problem.message}`)
  }
}

const listHuman = (
  io: CliIo,
  report: ReturnType<typeof listLegacyNotes>,
): void => {
  writeWarning(io)
  writeLine(io, `  source: ${report.source.path} (read-only, sha256 ${report.source.sha256})`)
  writeLine(
    io,
    `  type: ${report.type ?? "all"}, showing ${report.rows.length} of ${report.total}, offset ${report.offset}, limit ${report.limit}`,
  )
  if (report.rows.length === 0) {
    writeLine(io, "\nNo legacy rows matched.")
    return
  }
  writeLine(io)
  for (const row of report.rows) {
    writeLine(io, rowLabel(row))
    if (row.note !== null) {
      writeLine(io, `  title: ${row.note.title}`)
      writeLine(
        io,
        `  createdAt: ${row.note.createdAtIso}  updatedAt: ${row.note.updatedAtIso}`,
      )
      if (row.note.reference !== null) {
        writeLine(io, `  reference: ${row.note.reference}`)
      }
    }
    writeProblems(io, row)
  }
}

const showHuman = (
  io: CliIo,
  report: ReturnType<typeof getLegacyNote>,
): void => {
  writeWarning(io)
  writeLine(io, `  source: ${report.source.path} (read-only, sha256 ${report.source.sha256})`)
  writeLine(io, `  type: ${report.type}, id: ${report.legacyId}`)
  const row = report.row
  if (row === null) {
    writeLine(io, "\nNo legacy row matched. Nothing was imported or written.")
    return
  }
  writeLine(io)
  writeLine(io, rowLabel(row))
  writeProblems(io, row)
  const note = row.note
  if (note === null) {
    return
  }
  writeLine(io, `  title: ${note.title}`)
  writeLine(io, `  createdAt: ${note.createdAtIso}`)
  writeLine(io, `  updatedAt: ${note.updatedAtIso}`)
  if (note.reference !== null) {
    writeLine(io, `  reference: ${note.reference}`)
  }
  writeLine(io, "\nBody:\n")
  writeLine(io, note.body)
}

export const legacyCommand: CommandDefinition = {
  name: "legacy",
  summary: "Read the retired SQLite database through the one-release read-only view",
  usage:
    "legacy list [--db <path>] [--type <type>] [--limit <n>] [--offset <n>] [--json]\n       legacy show [--db <path>] --type <type> --id <legacyId> [--json]",
  details: [
    "Both commands read through the shared core compatibility reader. The",
    "source is copied and opened read-only; this command never imports rows,",
    "repairs data, or writes under .slipmem/.",
    "Without --db, the source is SLIPMEM_DB_PATH, then the XDG data database.",
    "List defaults to 25 rows (maximum 100) across all three legacy tables.",
  ],
  options: {
    db: { type: "string", valueName: "path" },
    type: { type: "string", valueName: "type" },
    id: { type: "string", valueName: "legacyId" },
    limit: { type: "number", valueName: "n" },
    offset: { type: "number", valueName: "n" },
  },
  minPositionals: 1,
  maxPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const action = parsed.positionals[0]!
      if (action !== "list" && action !== "show") {
        return yield* Effect.fail(
          usageError(
            `legacy supports only 'list' and 'show', not '${action}'.`,
            "legacy",
          ),
        )
      }
      if (stringOption(parsed, "dir") !== undefined) {
        return yield* Effect.fail(
          usageError(
            "legacy reads the retired SQLite source and does not use --dir; Markdown note commands use --dir instead.",
            "legacy",
          ),
        )
      }

      const databasePath = resolveSourceDatabasePath(
        context.cwd,
        stringOption(parsed, "db"),
        context.env,
        "legacy",
      )

      if (action === "list") {
        const type = parseNoteType(stringOption(parsed, "type"), "legacy")
        const limit = parseLimit(numberOption(parsed, "limit"), {
          command: "legacy",
          fallback: LEGACY_READ_DEFAULT_LIMIT,
          maximum: LEGACY_READ_MAX_LIMIT,
        })
        const offset = offsetFrom(numberOption(parsed, "offset"))
        const report = yield* Effect.try({
          try: () =>
            listLegacyNotes({
              databasePath,
              ...(type === undefined ? {} : { type }),
              limit,
              offset,
            }),
          catch: readError,
        })

        if (parsed.options.json === true) {
          writeJson(
            context.io,
            toPortableJson({ ok: true, warning: READ_ONLY_WARNING, report }),
          )
        } else {
          listHuman(context.io, report)
        }
        return 0
      }

      const requireType = requireStringOption(parsed, "type", "legacy")
      const type = parseNoteType(requireType, "legacy")!
      const id = requireStringOption(parsed, "id", "legacy")
      if (id.trim() === "" || id.length > LEGACY_READ_MAX_ID_LENGTH) {
        return yield* Effect.fail(
          usageError(
            `--id must be a non-empty legacy ID of ${LEGACY_READ_MAX_ID_LENGTH} characters or fewer.`,
            "legacy",
          ),
        )
      }
      const report = yield* Effect.try({
        try: () => getLegacyNote({ databasePath, type, legacyId: id }),
        catch: readError,
      })

      if (parsed.options.json === true) {
        writeJson(
          context.io,
          toPortableJson({
            ok: report.row !== null,
            warning: READ_ONLY_WARNING,
            report,
            ...(report.row === null
              ? {
                  error: {
                    kind: "not-found",
                    code: "legacy-not-found",
                    message: `No ${type} legacy row with id '${id}' exists in ${databasePath}. Nothing was imported or written.`,
                  },
                }
              : {}),
          }),
        )
      } else {
        showHuman(context.io, report)
      }
      return report.row === null ? 1 : 0
    }),
}
