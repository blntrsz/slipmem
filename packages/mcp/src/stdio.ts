import { Effect, Layer, Sink, Stdio, Stream } from "effect"
import { systemError, type PlatformError } from "effect/PlatformError"

const writeChunk =
  (stream: NodeJS.WritableStream, method: "stdout" | "stderr") =>
  (chunk: string | Uint8Array) =>
    Effect.callback<void, PlatformError>((resume) => {
      const fail = (cause: unknown) =>
        resume(
          Effect.fail(
            systemError({
              module: "Stdio",
              method,
              _tag: "Unknown",
              cause,
            }),
          ),
        )

      try {
        stream.write(chunk, (error?: Error | null) => {
          if (error) {
            fail(error)
          } else {
            resume(Effect.void)
          }
        })
      } catch (cause) {
        fail(cause)
      }
    })

const stdin = Stream.fromAsyncIterable<Uint8Array, PlatformError>(
  process.stdin as AsyncIterable<Uint8Array>,
  (cause) =>
    systemError({
      module: "Stdio",
      method: "stdin",
      _tag: "Unknown",
      cause,
    }),
)

/**
 * `Stdio` over the current Node/Bun process. This is the small subset of
 * `@effect/platform-node` that the stdio MCP transport needs, without pulling
 * in the rest of the platform packages.
 */
export const layer = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdinIsTerminal: Effect.sync(() => process.stdin.isTTY === true),
    stdoutIsTerminal: Effect.sync(() => process.stdout.isTTY === true),
    stderrIsTerminal: Effect.sync(() => process.stderr.isTTY === true),
    stdout: () => Sink.forEach(writeChunk(process.stdout, "stdout")),
    stderr: () => Sink.forEach(writeChunk(process.stderr, "stderr")),
    stdin,
  }),
)
