import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { resolveRootProgram } from "./config"
import { makeServerLayer } from "./server"

// Resolve the Markdown root before building any service. There is no implicit
// repository creation: an operator runs `slipmem init` or sets SLIPMEM_DIR.
const rootExit = Effect.runSyncExit(resolveRootProgram())

if (Exit.isFailure(rootExit)) {
  const error = Cause.squash(rootExit.cause)
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}

// Interrupt the main fiber on a signal so `Layer.launch` can close the
// disposable search index and flush the MCP transport before the process
// exits. This is the same runner pattern Effect's platform packages install for
// `runMain`; using it here keeps shutdown behavior without adding a platform
// dependency.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false

  const interrupt = () => {
    receivedSignal = true
    fiber.interruptUnsafe(fiber.id)
  }

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)

    // `makeRunMain`'s default reporter runs outside the server layer and would
    // write to stdout. Report failures here, on stderr, and only for failures
    // that have not already been reported.
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      const error = Cause.squash(exit.cause)
      if (Runtime.getErrorReported(error)) {
        process.stderr.write(`${Cause.pretty(exit.cause)}\n`)
      }
    }

    teardown(exit, (code) => {
      if (receivedSignal) {
        process.exit(0)
      } else if (code !== 0) {
        process.exit(code)
      }
    })
  })

  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
})

runMain(
  Layer.launch(makeServerLayer({ root: rootExit.value })),
  { disableErrorReporting: true },
)
