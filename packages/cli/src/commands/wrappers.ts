import { Effect } from "effect"
import { join, resolve } from "node:path"
import { usageError, type CliFailure } from "../errors.js"
import type { CommandDefinition } from "./command.js"

const repositoryRoot = resolve(import.meta.dir, "../../..")

const runChild = (
  command: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<number, CliFailure> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn({
        cmd: [...command],
        cwd,
        env: process.env,
        stdio: ["inherit", "inherit", "inherit"],
      })
      return await child.exited
    },
    catch: (cause) =>
      usageError(
        `Could not start the child entry point: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })

export const mcpCommand: CommandDefinition = {
  name: "mcp",
  summary: "Run the stdio MCP server entry point",
  usage: "mcp [-- <args>...]",
  details: [
    "This is a thin wrapper around packages/mcp/src/main.ts. It inherits stdio",
    "so MCP clients can use 'slipmem mcp' as the server command.",
  ],
  allowRest: true,
  minPositionals: 0,
  maxPositionals: 0,
  options: {},
  run: (parsed) =>
    runChild(
      [
        process.execPath,
        join(repositoryRoot, "packages/mcp/src/main.ts"),
        ...parsed.rest,
      ],
      repositoryRoot,
    ),
}

export const webCommand: CommandDefinition = {
  name: "web",
  summary: "Run the local web application entry point",
  usage: "web [-- <args>...]",
  details: [
    "This is a thin wrapper around the packages/web start script. It inherits",
    "stdio and the current environment, so HOST and PORT behave as documented.",
  ],
  allowRest: true,
  minPositionals: 0,
  maxPositionals: 0,
  options: {},
  run: (parsed) =>
    runChild(
      [
        process.execPath,
        "run",
        "--cwd",
        join(repositoryRoot, "packages/web"),
        "start",
        ...parsed.rest,
      ],
      repositoryRoot,
    ),
}
