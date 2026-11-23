import { ApprovalError, MarkdownError, WikiError } from "@slipmem/core"
import { Effect } from "effect"
import { GitCaptureError } from "./capture/errors.js"
import {
  GLOBAL_OPTIONS,
  parseArgs,
  type ParsedArguments,
} from "./args.js"
import type { CommandDefinition } from "./commands/command.js"
import { approveCommand } from "./commands/approve.js"
import { cacheCommand } from "./commands/cache.js"
import { captureCommand } from "./commands/capture.js"
import { checkCommand } from "./commands/check.js"
import { deleteCommand } from "./commands/delete.js"
import { editCommand } from "./commands/edit.js"
import { graphCommand } from "./commands/graph.js"
import { initCommand } from "./commands/init.js"
import { initiativeCommand } from "./commands/initiative.js"
import { legacyCommand } from "./commands/legacy.js"
import { listCommand } from "./commands/list.js"
import { migrateCommand } from "./commands/migrate.js"
import { newCommand } from "./commands/new.js"
import { rejectCommand } from "./commands/reject.js"
import { reviewCommand } from "./commands/review.js"
import { searchCommand } from "./commands/search.js"
import { serviceCommand } from "./commands/service.js"
import { showCommand } from "./commands/show.js"
import { tagsCommand } from "./commands/tags.js"
import { wikiCommand } from "./commands/wiki.js"
import { mcpCommand, webCommand } from "./commands/wrappers.js"
import type { CliContext } from "./context.js"
import { CliMigrationError, CliUnavailableError, CliUsageError, usageError } from "./errors.js"
import { runInitiativeCli } from "./initiative-cli.js"
import {
  PROGRAM,
  VERSION,
  renderCommandHelp,
  renderHelp,
} from "./help.js"
import { writeErrorLine } from "./output.js"

export const COMMANDS: ReadonlyArray<CommandDefinition> = [
  initCommand,
  newCommand,
  listCommand,
  showCommand,
  editCommand,
  deleteCommand,
  searchCommand,
  tagsCommand,
  checkCommand,
  cacheCommand,
  captureCommand,
  graphCommand,
  initiativeCommand,
  wikiCommand,
  migrateCommand,
  legacyCommand,
  reviewCommand,
  approveCommand,
  rejectCommand,
  mcpCommand,
  webCommand,
  serviceCommand,
]

const commandByName = (
  name: string,
  commands: ReadonlyArray<CommandDefinition>,
): CommandDefinition | undefined =>
  commands.find((command) => command.name === name)

const wantsJson = (argv: ReadonlyArray<string>): boolean =>
  argv.some((token) => token === "--json" || token === "--json=true")

interface FailureEnvelope {
  readonly ok: false
  readonly error: {
    readonly kind: "usage" | "unavailable" | "validation" | "migration" | "internal"
    readonly code: string
    readonly message: string
    readonly command?: string
    readonly area?: string
    readonly path?: string
    readonly field?: string
    readonly feature?: string
  }
}

const reportFailure = (
  error: unknown,
  context: CliContext,
  json: boolean,
): number => {
  let code = 1
  let envelope: FailureEnvelope

  if (error instanceof CliUsageError) {
    code = 2
    envelope = {
      ok: false,
      error: {
        kind: "usage",
        code: "usage",
        message: error.message,
        ...(error.command === undefined ? {} : { command: error.command }),
      },
    }
  } else if (error instanceof CliUnavailableError) {
    code = 2
    envelope = {
      ok: false,
      error: {
        kind: "unavailable",
        code: error.code,
        message: error.message,
        feature: error.feature,
      },
    }
  } else if (error instanceof CliMigrationError) {
    code = 1
    envelope = {
      ok: false,
      error: {
        kind: "migration",
        code: error.code,
        message: error.message,
      },
    }
  } else if (error instanceof MarkdownError) {
    code = 1
    envelope = {
      ok: false,
      error: {
        kind: "validation",
        code: error.code,
        message: error.message,
        area: error.area,
        path: error.path,
        ...(error.field === undefined ? {} : { field: error.field }),
      },
    }
  } else if (error instanceof WikiError) {
    code = 1
    envelope = {
      ok: false,
      error: {
        kind: "validation",
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.field === undefined ? {} : { field: error.field }),
      },
    }
  } else if (error instanceof ApprovalError) {
    code = 1
    envelope = {
      ok: false,
      error: {
        kind: "validation",
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.field === undefined ? {} : { field: error.field }),
      },
    }
  } else if (error instanceof GitCaptureError) {
    code = 1
    envelope = {
      ok: false,
      error: {
        kind: "validation",
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.field === undefined ? {} : { field: error.field }),
      },
    }
  } else {
    const message = error instanceof Error ? error.message : String(error)
    envelope = {
      ok: false,
      error: { kind: "internal", code: "internal", message },
    }
  }

  if (json) {
    writeErrorLine(context.io, JSON.stringify(envelope, null, 2))
  } else {
    const details = envelope.error
    writeErrorLine(context.io, `${PROGRAM}: ${details.message}`)
    if (details.area !== undefined || details.path !== undefined) {
      const location = [details.area, details.path]
        .filter((part) => part !== undefined)
        .join(": ")
      if (location.length > 0) {
        writeErrorLine(context.io, `  at ${location}`)
      }
    }
    if (details.field !== undefined) {
      writeErrorLine(context.io, `  field: ${details.field}`)
    }
    if (details.kind === "usage") {
      writeErrorLine(context.io, `  run '${PROGRAM} help' for usage`)
    }
  }

  return code
}

const runEffect = async (
  effect: ReturnType<CommandDefinition["run"]>,
  context: CliContext,
  json: boolean,
): Promise<number> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => reportFailure(error, context, json),
        onSuccess: (code) => code,
      }),
    ),
  )

const handleHelp = (
  argv: ReadonlyArray<string>,
  context: CliContext,
  commands: ReadonlyArray<CommandDefinition>,
): number => {
  const target = argv[0]
  if (target === undefined) {
    context.io.out(renderHelp(commands))
    return 0
  }
  const command = commandByName(target, commands)
  if (command === undefined) {
    return reportFailure(
      usageError(`Unknown command '${target}'.`, "help"),
      context,
      false,
    )
  }
  context.io.out(renderCommandHelp(command, GLOBAL_OPTIONS))
  return 0
}

const parseCommandArguments = (
  command: CommandDefinition,
  argv: ReadonlyArray<string>,
): ParsedArguments =>
  parseArgs(
    argv,
    { ...GLOBAL_OPTIONS, ...command.options },
    {
      command: command.name,
      ...(command.minPositionals === undefined
        ? {}
        : { minPositionals: command.minPositionals }),
      ...(command.maxPositionals === undefined
        ? {}
        : { maxPositionals: command.maxPositionals }),
      ...(command.allowRest === true ? { allowRest: true } : {}),
    },
  )

/**
 * Runs one CLI invocation. The function never throws for a user or note
 * validation error: it reports it and returns an exit status. Exit statuses are
 * 0 success, 1 validation/operational failure, and 2 usage or unavailable API.
 */
export const runCli = async (
  argv: ReadonlyArray<string>,
  context: CliContext,
  commands: ReadonlyArray<CommandDefinition> = COMMANDS,
): Promise<number> => {
  const jsonHint = wantsJson(argv)

  try {
    if (argv.length === 0) {
      context.io.out(renderHelp(commands))
      return 0
    }

    const first = argv[0]!
    if (first === "--version") {
      context.io.out(`${PROGRAM} ${VERSION}\n`)
      return 0
    }
    if (first === "--help" || first === "-h" || first === "help") {
      return handleHelp(argv.slice(1), context, commands)
    }

    const command = commandByName(first, commands)
    if (command === undefined) {
      throw usageError(
        `Unknown command '${first}'. Run '${PROGRAM} help' for usage.`,
        first,
      )
    }

    // The initiative command owns a strict parser for its subcommands, which
    // have option sets that differ per action. Route the raw argv through it
    // instead of pre-parsing against one flat option table.
    if (command.name === "initiative") {
      return await runInitiativeCli(argv.slice(1), context)
    }

    const parsed = parseCommandArguments(command, argv.slice(1))
    if (parsed.options.help === true) {
      context.io.out(renderCommandHelp(command, GLOBAL_OPTIONS))
      return 0
    }

    const json = parsed.options.json === true
    return await runEffect(command.run(parsed, context), context, json)
  } catch (error) {
    return reportFailure(error, context, jsonHint)
  }
}
