/**
 * Legacy SQLite server wiring.
 *
 * The HTTP server itself runs on the Markdown repository. This layer is kept
 * only for migration/read compatibility and historical tests, so it lives
 * behind an explicit subpath instead of the server root barrel.
 */
export { makeDatabaseLayer, type DatabaseLayerOptions } from "./database.js"
export {
  makeMigrationsLayer,
  MigrationError,
  resolveMigrationsFolder,
  runMigrations,
} from "./migrations.js"
