import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator"
import { Effect } from "effect"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NoteDatabaseService } from "../note-database"

// Tests run the same checked-in Drizzle migrations as the deployed servers.
// The migration artifacts live with the server package, which is responsible
// for upgrading databases; tests only read the generated files.
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "server/drizzle",
)

/** Applies the production Drizzle migrations to the current note database. */
export const migrateNoteDatabase = Effect.gen(function* () {
  const db = yield* NoteDatabaseService
  yield* migrate(db, { migrationsFolder })
})
