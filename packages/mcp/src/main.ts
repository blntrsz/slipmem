import { resolveDatabasePath } from "@slipmem/server"
import { Layer, Runtime } from "effect"
import { makeServerLayer } from "./server"

// The web server owns the default path and directory creation, so both
// transports resolve SLIPMEM_DB_PATH the same way.
const databasePath = resolveDatabasePath()

// Interrupt the main fiber on a signal so `Layer.launch` can close the SQLite
// connection and flush the MCP transport before the process exits. This is the
// same runner pattern Effect's platform packages install for `runMain`; using
// it here keeps shutdown behavior without adding a platform dependency.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false

  const interrupt = () => {
    receivedSignal = true
    fiber.interruptUnsafe(fiber.id)
  }

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
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

runMain(Layer.launch(makeServerLayer(databasePath)))
