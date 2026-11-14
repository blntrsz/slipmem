import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { makeServerLayer } from "./server"

const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")

const databasePath =
  process.env.SLIPMEM_DB_PATH ?? join(dataHome, "slipmem", "slipmem.db")

if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true })
}

Layer.launch(makeServerLayer(databasePath)).pipe(Effect.runPromise).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
