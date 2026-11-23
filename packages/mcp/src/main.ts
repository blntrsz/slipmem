import { Cause, Context, Effect, Exit, Layer, Runtime } from "effect"
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

// Interrupt the main fiber on a signal or stdin EOF so `Layer.launch` can close
// the disposable search index and flush the MCP transport before the process
// exits. This is the same runner pattern Effect's platform packages install for
// `runMain`; using it here keeps shutdown behavior without adding a platform
// dependency.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  // A signal or stdin close is an intentional shutdown, not the generic `130`
  // interruption exit code. Real layer failures still keep their own code.
  const interrupt = () =>
    fiber.interruptUnsafe(
      fiber.id,
      Context.make(Runtime.InterruptExitCode, 0),
    )

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    process.stdin.removeListener("end", interrupt)
    process.stdin.removeListener("close", interrupt)

    // `makeRunMain`'s default reporter runs outside the server layer and would
    // write to stdout. With error reporting disabled, print every non-interrupt
    // startup/shutdown failure here, on stderr, where it cannot corrupt the
    // protocol stream.
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      process.stderr.write(`${Cause.pretty(exit.cause)}\n`)
    }

    teardown(exit, (code) => {
      process.exit(code)
    })
  })

  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  // The transport is finished when its input closes. Interrupt explicitly so
  // shutdown does not depend on whichever read the protocol scheduler reaches
  // first.
  process.stdin.once("end", interrupt)
  process.stdin.once("close", interrupt)
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
