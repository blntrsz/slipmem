import { usageError } from "./errors.js"

export type OptionType = "boolean" | "string" | "number" | "list"

export interface OptionSpec {
  readonly type: OptionType
  /** Human-facing value placeholder, for help and errors. */
  readonly valueName?: string
}

export type OptionValue = boolean | number | string | ReadonlyArray<string>

export interface ParsedArguments {
  readonly options: Readonly<Record<string, OptionValue>>
  readonly positionals: ReadonlyArray<string>
  readonly rest: ReadonlyArray<string>
}

export interface ParseOptions {
  readonly command?: string
  readonly minPositionals?: number
  readonly maxPositionals?: number
  /** Collect everything after `--` verbatim instead of treating it as positionals. */
  readonly allowRest?: boolean
}

export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  help: { type: "boolean" },
  json: { type: "boolean" },
  dir: { type: "string", valueName: "path" },
}

const valueName = (name: string, spec: OptionSpec): string =>
  spec.valueName ?? name

function fail(message: string, command: string | undefined): never {
  throw usageError(message, command)
}

const parseBoolean = (
  name: string,
  raw: string | undefined,
  command: string | undefined,
): boolean => {
  if (raw === undefined) {
    return true
  }
  if (raw === "true") {
    return true
  }
  if (raw === "false") {
    return false
  }
  return fail(
    `Option --${name} expects true or false, not '${raw}'.`,
    command,
  )
}

const parseNumber = (
  name: string,
  raw: string,
  command: string | undefined,
): number => {
  const value = Number(raw)
  if (raw.trim() === "" || !Number.isFinite(value)) {
    return fail(`Option --${name} expects a number, not '${raw}'.`, command)
  }
  return value
}

/**
 * Parses strict command-line flags. Unknown or malformed options fail instead of
 * being forwarded to a core service, so a typo cannot silently change a write.
 *
 * Supported forms are `--name value`, `--name=value`, and repeatable
 * `--name value` for list options. `-h` is the only short alias. Everything
 * after `--` is a positional argument unless the command opts into a raw rest
 * list.
 */
export const parseArgs = (
  argv: ReadonlyArray<string>,
  specs: Readonly<Record<string, OptionSpec>>,
  options: ParseOptions = {},
): ParsedArguments => {
  const command = options.command
  const parsed: Record<string, OptionValue> = {}
  const positionals: string[] = []
  const rest: string[] = []
  let index = 0
  let literal = false

  const assign = (name: string, spec: OptionSpec, raw: string | undefined): void => {
    if (spec.type === "list") {
      if (raw === undefined) {
        fail(`Option --${name} requires a value.`, command)
      }
      const current = parsed[name]
      const values = Array.isArray(current) ? [...current] : []
      values.push(raw)
      parsed[name] = values
      return
    }

    if (parsed[name] !== undefined) {
      fail(`Option --${name} may only be given once.`, command)
    }

    switch (spec.type) {
      case "boolean":
        parsed[name] = parseBoolean(name, raw, command)
        break
      case "number":
        if (raw === undefined) {
          fail(`Option --${name} requires a value.`, command)
        }
        parsed[name] = parseNumber(name, raw, command)
        break
      case "string":
        if (raw === undefined) {
          fail(`Option --${name} requires a value.`, command)
        }
        parsed[name] = raw
        break
    }
  }

  while (index < argv.length) {
    const token = argv[index]!

    if (literal) {
      if (options.allowRest === true) {
        rest.push(token)
      } else {
        positionals.push(token)
      }
      index++
      continue
    }

    if (token === "--") {
      literal = true
      index++
      continue
    }

    if (token === "-h") {
      assign("help", { type: "boolean" }, undefined)
      index++
      continue
    }

    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2)
      const equals = body.indexOf("=")
      const name = equals === -1 ? body : body.slice(0, equals)
      const inline = equals === -1 ? undefined : body.slice(equals + 1)
      const spec = specs[name]

      if (spec === undefined) {
        fail(`Unknown option --${name}. Run 'slipmem help' for usage.`, command)
      }

      if (spec.type === "boolean" && inline === undefined) {
        assign(name, spec, undefined)
        index++
        continue
      }

      if (inline !== undefined) {
        assign(name, spec, inline)
        index++
        continue
      }

      const next = argv[index + 1]
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        fail(
          `Option --${name} requires a value (${valueName(name, spec)}).`,
          command,
        )
      }
      assign(name, spec, next)
      index += 2
      continue
    }

    if (token.startsWith("-") && token !== "-") {
      fail(
        `Unknown option ${token}. Use '--' before positional values that start with '-'.`,
        command,
      )
    }

    positionals.push(token)
    index++
  }

  const minimum = options.minPositionals ?? 0
  const maximum = options.maxPositionals ?? Number.POSITIVE_INFINITY
  if (positionals.length < minimum) {
    fail(
      minimum === 1
        ? "This command requires one positional argument."
        : `This command requires at least ${minimum} positional arguments.`,
      command,
    )
  }
  if (positionals.length > maximum) {
    fail(
      maximum === 0
        ? "This command does not accept positional arguments."
        : `This command accepts at most ${maximum} positional arguments.`,
      command,
    )
  }

  return { options: parsed, positionals, rest }
}

export const stringOption = (
  parsed: ParsedArguments,
  name: string,
): string | undefined => {
  const value = parsed.options[name]
  return typeof value === "string" ? value : undefined
}

export const booleanOption = (
  parsed: ParsedArguments,
  name: string,
): boolean => parsed.options[name] === true

export const numberOption = (
  parsed: ParsedArguments,
  name: string,
): number | undefined => {
  const value = parsed.options[name]
  return typeof value === "number" ? value : undefined
}

export const listOption = (
  parsed: ParsedArguments,
  name: string,
): ReadonlyArray<string> => {
  const value = parsed.options[name]
  return Array.isArray(value) ? value : []
}

export const requireStringOption = (
  parsed: ParsedArguments,
  name: string,
  command?: string,
): string => {
  const value = stringOption(parsed, name)
  if (value === undefined || value.trim() === "") {
    throw usageError(`This command requires --${name} <value>.`, command)
  }
  return value
}
