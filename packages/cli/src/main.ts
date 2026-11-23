#!/usr/bin/env bun
import { runCli } from "./cli.js"
import { systemContext } from "./context.js"
import { installSignalInterrupts } from "./signals.js"

const controller = new AbortController()
const removeInterrupts = installSignalInterrupts(controller)
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    systemContext(),
    undefined,
    controller.signal,
  )
} finally {
  removeInterrupts()
}
