import { Effect } from "effect"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { stringOption, type ParsedArguments } from "../args.js"
import { resolveRoot, type CliContext } from "../context.js"
import { usageError, type CliFailure } from "../errors.js"
import type { CommandDefinition } from "./command.js"

// This file lives at packages/cli/src/commands, so the checkout root is four
// levels up. The extra level matters: three levels resolves to packages/ and
// produces a broken `packages/packages/mcp/...` path.
const repositoryRoot = resolve(import.meta.dir, "../../../..")
const mcpEntrypoint = join(repositoryRoot, "packages/mcp/src/main.ts")
const webDirectory = join(repositoryRoot, "packages/web")

const requireEntrypoint = (path: string, label: string): void => {
  if (!existsSync(path)) {
    throw usageError(
      `The ${label} entry point is missing at ${path}. Run from a complete slipmem checkout, or use the direct entry point documented for this surface.`,
    )
  }
}

const runChild = (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
  },
): Effect.Effect<number, CliFailure> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn({
        cmd: [...command],
        cwd: options.cwd,
        env: options.env,
        stdio: ["inherit", "inherit", "inherit"],
      })
      return await child.exited
    },
    catch: (cause) =>
      usageError(
        `Could not start the child entry point: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })

/**
 * Resolves the note root in the caller's context, then passes the absolute
 * result to the child through `SLIPMEM_DIR`. This keeps `--dir`, relative
 * `SLIPMEM_DIR`, and ancestor discovery working when the wrapper is launched
 * from outside the repository and the web child runs in its own package
 * directory.
 */
const childContext = (
  parsed: ParsedArguments,
  context: CliContext,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
    return {
      cwd: context.cwd,
      env: { ...context.env, SLIPMEM_DIR: resolved.root },
    }
  })

export const mcpCommand: CommandDefinition = {
  name: "mcp",
  summary: "Run the stdio MCP server entry point",
  usage: "mcp [--dir <path>] [-- <args>...]",
  details: [
    "This is a thin wrapper around packages/mcp/src/main.ts. It inherits stdio",
    "so MCP clients can use 'slipmem mcp' as the server command. The child cwd",
    "is the caller's cwd and SLIPMEM_DIR is the resolved note root.",
  ],
  allowRest: true,
  minPositionals: 0,
  maxPositionals: 0,
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      requireEntrypoint(mcpEntrypoint, "MCP")
      const child = yield* childContext(parsed, context)
      return yield* runChild(
        [process.execPath, mcpEntrypoint, ...parsed.rest],
        child,
      )
    }),
}

export const webCommand: CommandDefinition = {
  name: "web",
  summary: "Run the local web development entry point",
  usage: "web [--dir <path>] [-- <args>...]",
  details: [
    "This is a thin wrapper around the packages/web start script, the same",
    "Vite development host as 'bun run web'. It inherits stdio and passes the",
    "resolved note root as SLIPMEM_DIR; HOST and PORT are read by the Vite",
    "config. For the production server use 'bun run web:build && bun run",
    "web:serve'.",
  ],
  allowRest: true,
  minPositionals: 0,
  maxPositionals: 0,
  options: {},
  run: (parsed, context) =>
    Effect.gen(function* () {
      requireEntrypoint(webDirectory, "web")
      const child = yield* childContext(parsed, context)
      return yield* runChild(
        [
          process.execPath,
          "run",
          "--cwd",
          webDirectory,
          "start",
          ...parsed.rest,
        ],
        child,
      )
    }),
}
