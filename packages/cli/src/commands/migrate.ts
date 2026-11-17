import {
  importMigration,
  MigrationImportError,
  MigrationSourceError,
  type MigrationImportReport,
} from "@slipmem/core"
import { Effect } from "effect"
import { join, resolve } from "node:path"
import { booleanOption, requireStringOption, stringOption } from "../args.js"
import { resolveRoot } from "../context.js"
import { migrationError, usageError } from "../errors.js"
import { writeJson, writeLine, type CliIo } from "../output.js"
import type { CommandDefinition } from "./command.js"

const failureDetails = (
  cause: unknown,
): { readonly code: string; readonly message: string; readonly report: MigrationImportReport | null } => {
  if (typeof cause === "object" && cause !== null) {
    const record = cause as {
      readonly code?: unknown
      readonly message?: unknown
      readonly report?: unknown
    }
    if (typeof record.report === "object" && record.report !== null) {
      return {
        code: typeof record.code === "string" ? record.code : "migration-failed",
        message:
          typeof record.message === "string"
            ? record.message
            : "The migration failed.",
        report: record.report as MigrationImportReport,
      }
    }
  }
  if (cause instanceof MigrationImportError) {
    return { code: cause.code, message: cause.message, report: cause.report }
  }
  if (cause instanceof MigrationSourceError) {
    return { code: cause.code, message: cause.message, report: null }
  }
  return {
    code: "migration-failed",
    message: cause instanceof Error ? cause.message : String(cause),
    report: null,
  }
}

const writeReportHuman = (
  report: MigrationImportReport,
  io: Pick<CliIo, "out">,
): void => {
  const counts = report.counts
  const planCounts = report.plan.counts
  writeLine(
    io,
    `${report.dryRun ? "Migration dry run" : "SQLite migration"} (${report.status})`,
  )
  writeLine(io, `  source:  ${report.sourceCheck.path}`)
  writeLine(io, `  target:  ${report.root.path}`)
  writeLine(
    io,
    `  source unchanged: ${report.sourceCheck.unchanged ? "yes" : "NO"}`,
  )
  writeLine(
    io,
    `  rows: ${counts.sourceRows}, planned: ${counts.plannedNotes}, written: ${counts.writtenNotes}, skipped: ${counts.skippedNotes}, malformed: ${counts.malformedRows}, quarantined: ${counts.quarantinedRows}`,
  )
  writeLine(
    io,
    `  by type: permanent ${planCounts.plannedByType.permanent}, fleeting ${planCounts.plannedByType.fleeting}, literature ${planCounts.plannedByType.literature}`,
  )
  writeLine(
    io,
    `  collisions: ${counts.collisions}, source errors: ${counts.sourceErrors}, source warnings: ${counts.sourceWarnings}, importer warnings: ${counts.importerWarnings}`,
  )
  if (report.backup !== null) {
    writeLine(
      io,
      `  backup: ${report.backup.path} (verified: ${report.backup.verified ? "yes" : "no"})`,
    )
  }
  if (report.manifestPath !== null) {
    writeLine(io, `  manifest: ${report.manifestPath}`)
  }
  if (report.dryRun) {
    writeLine(io, "  verification: not applicable (dry run writes no files)")
  } else {
    writeLine(
      io,
      `  verification: ${report.verification.ok ? "OK" : "FAILED"} (expected ${report.verification.expectedNotes}, written ${report.verification.writtenNotes}, parsed ${report.verification.parsedNotes})`,
    )
  }

  if (report.notes.length > 0) {
    writeLine(io, "\nSample mapping:")
    for (const note of report.notes.slice(0, 10)) {
      writeLine(
        io,
        `  ${note.legacyId} -> ${note.filename} (${note.type}, ${note.status})`,
      )
    }
    if (report.notes.length > 10) {
      writeLine(io, `  ... and ${report.notes.length - 10} more`)
    }
  }

  const issues = report.plan.issues
  if (issues.length > 0) {
    writeLine(io, `\nPlan issues (${issues.length}):`)
    for (const issue of issues.slice(0, 10)) {
      const problem = issue.problems[0]
      writeLine(
        io,
        `  - ${issue.severity} ${problem?.code ?? "issue"}${issue.legacyId === null ? "" : ` [${issue.legacyId}]`}: ${problem?.message ?? "See migration report."}`,
      )
    }
    if (issues.length > 10) {
      writeLine(io, `  ... and ${issues.length - 10} more`)
    }
  }

  if (report.warnings.length > 0) {
    writeLine(io, `\nWarnings (${report.warnings.length}):`)
    for (const warning of report.warnings.slice(0, 10)) {
      writeLine(io, `  - ${warning.code}: ${warning.message}`)
    }
    if (report.warnings.length > 10) {
      writeLine(io, `  ... and ${report.warnings.length - 10} more`)
    }
  }

  if (report.error !== null) {
    writeLine(io, `\nError: ${report.error.code}: ${report.error.message}`)
  }
  if (report.dryRun) {
    writeLine(
      io,
      "\nNo files were written. Dry run leaves the source database and target root unchanged.",
    )
  }
}

export const migrateCommand: CommandDefinition = {
  name: "migrate",
  summary: "Plan or import legacy SQLite notes as Markdown notes",
  usage: "migrate sqlite --db <path> [--dry-run] [--merge] [--json]",
  details: [
    "The source database is opened read-only and hashed before and after.",
    "A real import refuses a non-empty target root unless --merge is given,",
    "backs up the source under .slipmem/.state/migrations/, writes through the",
    "shared atomic serializer, re-reads every note, and writes a manifest.",
    "Dry run reports counts, collisions, and malformed rows and writes nothing.",
  ],
  options: {
    db: { type: "string", valueName: "path" },
    "dry-run": { type: "boolean" },
    merge: { type: "boolean" },
  },
  minPositionals: 1,
  maxPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const kind = parsed.positionals[0]!
      if (kind !== "sqlite") {
        return yield* Effect.fail(
          usageError(
            `migrate supports only 'sqlite', not '${kind}'.`,
            "migrate",
          ),
        )
      }

      const databasePath = resolve(
        context.cwd,
        requireStringOption(parsed, "db", "migrate"),
      )
      const dryRun = booleanOption(parsed, "dry-run")
      const merge = booleanOption(parsed, "merge")

      const resolved = yield* resolveRoot(
        context,
        stringOption(parsed, "dir"),
      ).pipe(
        Effect.match({
          onFailure: () => ({
            root: join(context.cwd, ".slipmem"),
            source: "cwd" as const,
          }),
          onSuccess: (resolution) => resolution,
        }),
      )

      const outcome = yield* Effect.sync(() => {
        try {
          return {
            report: importMigration({
              databasePath,
              noteRoot: resolved.root,
              dryRun,
              merge,
            }),
            failure: null,
          }
        } catch (cause) {
          return { report: null, failure: failureDetails(cause) }
        }
      })

      const report = outcome.report ?? outcome.failure?.report ?? null
      if (report === null) {
        const failure = outcome.failure!
        return yield* Effect.fail(
          migrationError(failure.message, failure.code),
        )
      }

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: report.ok,
          dryRun: report.dryRun,
          root: resolved.root,
          report,
        })
      } else {
        writeReportHuman(report, context.io)
      }

      return report.ok ? 0 : 1
    }),
}
