import type { OptionSpec } from "./args.js"
import type { CommandDefinition } from "./commands/command.js"

export const PROGRAM = "slipmem"
export const VERSION = "0.0.0"

const optionLabel = (name: string, spec: OptionSpec): string => {
  const value = spec.valueName ?? (spec.type === "number" ? "n" : "value")
  switch (spec.type) {
    case "boolean":
      return `--${name}`
    case "list":
      return `--${name} <${value}>...`
    default:
      return `--${name} <${value}>`
  }
}

const optionRows = (
  specs: Readonly<Record<string, OptionSpec>>,
): ReadonlyArray<readonly [string, string]> =>
  Object.entries(specs).map(([name, spec]) => [
    optionLabel(name, spec),
    spec.type === "boolean" ? "flag" : "value",
  ])

export const renderHelp = (
  commands: ReadonlyArray<CommandDefinition>,
): string => {
  const width = Math.max(...commands.map((command) => command.name.length), 8)
  const lines = [
    `${PROGRAM} ${VERSION} - local-first Markdown memory`,
    "",
    `Usage: ${PROGRAM} <command> [options]`,
    "",
    "Commands:",
    ...commands.map(
      (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
    ),
    "",
    "Global options:",
    "  --json              Machine-readable result or error",
    "  --dir <path>        Note root (same as SLIPMEM_DIR for this invocation)",
    "  -h, --help          Show help for a command",
    "  --version           Print the CLI version",
    "",
    `Run '${PROGRAM} help <command>' for command options.`,
  ]
  return `${lines.join("\n")}\n`
}

export const renderCommandHelp = (
  command: CommandDefinition,
  globalOptions: Readonly<Record<string, OptionSpec>>,
): string => {
  const lines = [
    `${PROGRAM} ${command.name} - ${command.summary}`,
    "",
    `Usage: ${PROGRAM} ${command.usage}`,
    ...(command.details === undefined
      ? []
      : ["", ...command.details.map((line) => `  ${line}`)]),
    "",
    "Options:",
    ...[...optionRows(globalOptions), ...optionRows(command.options ?? {})].map(
      ([label, kind]) => `  ${label.padEnd(28)} ${kind}`,
    ),
  ]
  return `${lines.join("\n")}\n`
}
