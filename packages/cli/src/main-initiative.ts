#!/usr/bin/env bun
import { systemContext } from "./context.js"
import { runInitiativeCli } from "./initiative-cli.js"
import { installSignalInterrupts } from "./signals.js"

const controller = new AbortController()
const removeInterrupts = installSignalInterrupts(controller)
try {
  process.exitCode = await runInitiativeCli(
    process.argv.slice(2),
    systemContext(),
    controller.signal,
  )
} finally {
  removeInterrupts()
}
