import { describe, expect, test } from "bun:test"
import { GLOBAL_OPTIONS, listOption, parseArgs } from "./args.js"
import { CliUsageError } from "./errors.js"

const specs = {
  ...GLOBAL_OPTIONS,
  type: { type: "string" as const },
  tag: { type: "list" as const },
  limit: { type: "number" as const },
  yes: { type: "boolean" as const },
}

const usage = (argv: ReadonlyArray<string>, options = {}): CliUsageError => {
  try {
    parseArgs(argv, specs, options)
  } catch (error) {
    if (error instanceof CliUsageError) {
      return error
    }
    throw error
  }
  throw new Error("Expected a CliUsageError")
}

describe("CLI argument parsing", () => {
  test("parses values, equals forms, repeatable lists, and positionals", () => {
    const parsed = parseArgs(
      [
        "search",
        "bounded memory",
        "--type=permanent",
        "--tag",
        "agent-memory",
        "--tag=retrieval",
        "--limit",
        "5",
        "--json",
      ],
      specs,
    )

    expect(parsed.positionals).toEqual(["search", "bounded memory"])
    expect(parsed.options.type).toBe("permanent")
    expect(listOption(parsed, "tag")).toEqual(["agent-memory", "retrieval"])
    expect(parsed.options.limit).toBe(5)
    expect(parsed.options.json).toBe(true)
  })

  test("rejects unknown, duplicate, and missing-value options", () => {
    expect(usage(["--wat"]).message).toContain("Unknown option --wat")
    expect(usage(["--limit"]).message).toContain("requires a value")
    expect(usage(["--limit", "nope"]).message).toContain("expects a number")
    expect(usage(["--type", "fleeting", "--type", "permanent"]).message).toContain(
      "may only be given once",
    )
    expect(usage(["--json=maybe"]).message).toContain("true or false")
  })

  test("enforces positional bounds and allows literal dash values after --", () => {
    expect(
      usage(["one", "two"], { minPositionals: 0, maxPositionals: 1 }).message,
    ).toContain("at most 1")
    expect(usage([], { minPositionals: 1 }).message).toContain("requires one")

    const parsed = parseArgs(["search", "--", "-draft query"], specs)
    expect(parsed.positionals).toEqual(["search", "-draft query"])
  })

  test("collects a raw rest list only when the command opts in", () => {
    const parsed = parseArgs(["mcp", "--", "--stdio"], specs, { allowRest: true })
    expect(parsed.positionals).toEqual(["mcp"])
    expect(parsed.rest).toEqual(["--stdio"])
  })
})
