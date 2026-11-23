import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import {
  formatAutomaticMemoryNotice,
  resolveAutomaticMemoryRuntime,
  resolveRecallProvider,
  type AutomaticMemoryRuntime,
  type RecallProviderRuntime,
} from "./automatic-memory"
import { resolveRootProgram } from "./config"
import { makeServerLayer } from "./server"

const failStartup = (error: unknown): never => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}

// Resolve the Markdown root before building any service. There is no implicit
// repository creation: an operator runs `slipmem init` or sets SLIPMEM_DIR.
const rootExit = Effect.runSyncExit(resolveRootProgram())

const root = Exit.isFailure(rootExit)
  ? failStartup(Cause.squash(rootExit.cause))
  : rootExit.value

const resolveProviders = (): {
  readonly automaticMemory: AutomaticMemoryRuntime
  readonly recallProvider: RecallProviderRuntime
} => {
  try {
    return {
      automaticMemory: resolveAutomaticMemoryRuntime(process.env),
      // Resolve once here so the startup notice and the service layer describe
      // the same provider. The adapter constructs no client and performs no
      // egress.
      recallProvider: resolveRecallProvider(process.env),
    }
  } catch (error) {
    return failStartup(error)
  }
}

const { automaticMemory, recallProvider } = resolveProviders()

const notice = formatAutomaticMemoryNotice(automaticMemory)
if (notice !== undefined) {
  process.stderr.write(`${notice}\n`)
}
if (recallProvider.notice !== undefined) {
  process.stderr.write(`${recallProvider.notice}\n`)
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
  Layer.launch(
    makeServerLayer({
      root,
      automaticMemory,
      ...(recallProvider.evaluator === undefined
        ? {}
        : { recallEvaluator: recallProvider.evaluator }),
    }),
  ),
  { disableErrorReporting: true },
)
