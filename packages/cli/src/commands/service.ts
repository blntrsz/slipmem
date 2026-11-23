import {
  ServiceError,
  inspectService,
  startService,
  stopService,
  type ServiceStatus,
  type StartServiceResult,
  type StopServiceResult,
} from "@slipmem/service"
import { Effect } from "effect"
import { numberOption, stringOption, type ParsedArguments } from "../args.js"
import { resolveRoot, type CliContext } from "../context.js"
import { unavailable, usageError } from "../errors.js"
import { writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

type ServiceAction = "start" | "status" | "stop"

const actionOf = (parsed: ParsedArguments): ServiceAction | undefined => {
  const action = parsed.positionals[0]
  return action === "start" || action === "status" || action === "stop"
    ? action
    : undefined
}

const fromServiceError = (cause: unknown) => {
  if (cause instanceof ServiceError) {
    return cause.code === "config" ||
      cause.code === "invalid-port" ||
      cause.code === "already-running"
      ? usageError(cause.message, "service")
      : unavailable("service", cause.message, cause.code)
  }
  return unavailable(
    "service",
    cause instanceof Error ? cause.message : String(cause),
    "service-error",
  )
}

const runService = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, ReturnType<typeof fromServiceError>> =>
  Effect.tryPromise({
    try: operation,
    catch: fromServiceError,
  })

const startShape = (result: StartServiceResult) => ({
  ok: true,
  action: "start",
  status: result.status,
  root: result.state.root,
  pid: result.state.pid,
  url: result.state.url,
  mcpUrl: result.mcpUrl,
  healthUrl: `${result.state.url}/service/health`,
  startedAt: result.state.startedAt,
})

const statusShape = (status: ServiceStatus) => ({
  ok: true,
  action: "status",
  root: status.root,
  running: status.running,
  ready: status.ready,
  starting: status.starting,
  ...(status.pid === undefined ? {} : { pid: status.pid }),
  ...(status.url === undefined ? {} : { url: status.url }),
  ...(status.mcpUrl === undefined ? {} : { mcpUrl: status.mcpUrl }),
  ...(status.healthUrl === undefined ? {} : { healthUrl: status.healthUrl }),
  ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
  ...(status.reason === undefined ? {} : { reason: status.reason }),
})

const stopShape = (result: StopServiceResult) => ({
  ok: true,
  action: "stop",
  status: result.status,
  root: result.root,
  ...(result.pid === undefined ? {} : { pid: result.pid }),
  forced: result.forced,
  ...(result.reason === undefined ? {} : { reason: result.reason }),
})

const reportStart = (
  context: CliContext,
  json: boolean,
  result: StartServiceResult,
): void => {
  if (json) {
    writeJson(context.io, startShape(result))
    return
  }
  writeLine(
    context.io,
    result.status === "started"
      ? `Started slipmem service for ${result.state.root}`
      : `slipmem service is already running for ${result.state.root}`,
  )
  writeLine(context.io, `  pid: ${result.state.pid}`)
  writeLine(context.io, `  mcp: ${result.mcpUrl}`)
  writeLine(context.io, `  health: ${result.state.url}/service/health`)
}

const reportStatus = (
  context: CliContext,
  json: boolean,
  status: ServiceStatus,
): void => {
  if (json) {
    writeJson(context.io, statusShape(status))
    return
  }
  if (!status.running) {
    writeLine(context.io, `slipmem service is not running for ${status.root}`)
    if (status.reason !== undefined) {
      writeLine(context.io, `  ${status.reason}`)
    }
    return
  }
  writeLine(
    context.io,
    `slipmem service is ${status.ready ? "ready" : "starting (not ready)"} for ${status.root}`,
  )
  if (status.pid !== undefined) {
    writeLine(context.io, `  pid: ${status.pid}`)
  }
  if (status.mcpUrl !== undefined) {
    writeLine(context.io, `  mcp: ${status.mcpUrl}`)
  }
  if (status.reason !== undefined) {
    writeLine(context.io, `  ${status.reason}`)
  }
}

const reportStop = (
  context: CliContext,
  json: boolean,
  result: StopServiceResult,
): void => {
  if (json) {
    writeJson(context.io, stopShape(result))
    return
  }
  if (result.status === "not-running") {
    writeLine(
      context.io,
      `slipmem service was not running for ${result.root}`,
    )
    return
  }
  writeLine(
    context.io,
    `Stopped slipmem service for ${result.root}${
      result.forced ? " (forced after timeout)" : ""
    }`,
  )
}

export const serviceCommand: CommandDefinition = {
  name: "service",
  summary:
    "Start, inspect, or stop the per-root background service that owns consolidation",
  usage: "service <start|status|stop> [--port <n>] [--json]",
  details: [
    "One service process per canonical note root owns the scoped consolidation",
    "worker and stays alive after MCP clients disconnect. It binds only to",
    "127.0.0.1 and mounts the same JSON API and HTTP MCP endpoint as the web",
    "entry. status and stop never require or resolve a model configuration.",
    "start requires the explicit serving chat model unless a matching service is",
    "already running. Use the returned mcp URL in an explicitly shared MCP client",
    "configuration, or start with --port for a stable endpoint.",
  ],
  minPositionals: 0,
  maxPositionals: 1,
  options: {
    port: { type: "number", valueName: "n" },
  },
  run: (parsed, context) =>
    Effect.gen(function* () {
      const action = actionOf(parsed)
      if (action === undefined) {
        return yield* Effect.fail(
          usageError(
            `service supports 'start', 'status', or 'stop', not '${parsed.positionals[0] ?? ""}'.`,
            "service",
          ),
        )
      }
      if (action !== "start" && parsed.options.port !== undefined) {
        return yield* Effect.fail(
          usageError("--port is only valid with 'service start'.", "service"),
        )
      }

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const json = parsed.options.json === true
      const port = numberOption(parsed, "port")

      if (action === "start") {
        const result = yield* runService(() =>
          startService({
            root: resolved.root,
            env: context.env,
            ...(port === undefined ? {} : { port }),
          }),
        )
        reportStart(context, json, result)
        return 0
      }

      if (action === "status") {
        const status = yield* runService(() => inspectService(resolved.root))
        reportStatus(context, json, status)
        return 0
      }

      const result = yield* runService(() =>
        stopService({ root: resolved.root }),
      )
      reportStop(context, json, result)
      return 0
    }),
}
