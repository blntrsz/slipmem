import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { SqliteClient as SqliteClientService } from "@effect/sql-sqlite-bun/SqliteClient"
import type { EffectDrizzleQueryError, MigratorInitError } from "drizzle-orm/effect-core"
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun"
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Cause, Data, Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Raised when the database cannot be migrated safely.
 *
 * This is deliberately a typed failure rather than a defect: a bad database or
 * a missing migrations folder should stop startup with an actionable message,
 * not silently fall through to a schema the services assume.
 */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly message: string
}> {}

const migrationsFolderName = "drizzle"
const migrationsTable = "__drizzle_migrations"

type DatabaseClient = SqlClient
type MigrationFailure = MigrationError | SqlError | EffectDrizzleQueryError | MigratorInitError

interface TableInfoRow {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

interface ExpectedColumn {
  readonly name: string
  readonly type: "TEXT" | "REAL"
  readonly notNull: boolean
  readonly primaryKey: boolean
}

interface ExpectedTable {
  readonly name: string
  readonly columns: ReadonlyArray<ExpectedColumn>
}

// The shape produced by the pre-Drizzle CREATE TABLE bootstrap. This must stay
// frozen: it is used to recognise a legacy database before the initial
// migration adopts it, and a future migration can legitimately change a note
// table away from this shape. Do not add later columns or tables here.
const legacyNoteTables: ReadonlyArray<ExpectedTable> = [
  {
    name: "fleeting_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
  {
    name: "literature_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "reference", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
  {
    name: "permanent_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
]

// The shape produced after every checked-in migration has run. Update this
// list whenever a migration changes a note table; startup validates the
// migrated database against it. Keep `legacyNoteTables` untouched.
const noteTables: ReadonlyArray<ExpectedTable> = [
  {
    name: "fleeting_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
  {
    name: "literature_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "reference", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
  {
    name: "permanent_note",
    columns: [
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "title", type: "TEXT", notNull: true, primaryKey: false },
      { name: "content", type: "TEXT", notNull: true, primaryKey: false },
      { name: "created_at", type: "REAL", notNull: true, primaryKey: false },
      { name: "updated_at", type: "REAL", notNull: true, primaryKey: false },
    ],
  },
]

const hasMigrationFiles = (folder: string): boolean => {
  if (!existsSync(folder)) return false

  try {
    return readdirSync(folder, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "migration.sql")),
    )
  } catch {
    return false
  }
}

const folderCandidates = (start: string): ReadonlyArray<string> => {
  const candidates: Array<string> = []
  let current = resolve(start)

  // Walk up from both this module and the working directory. In development
  // the module lives in packages/server/src; in a Vite SSR build it lives in
  // packages/web/dist. In both cases the repository root is an ancestor.
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(
      join(current, "packages", "server", migrationsFolderName),
      join(current, "server", migrationsFolderName),
    )

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return candidates
}

/**
 * Finds the checked-in Drizzle migrations.
 *
 * `SLIPMEM_MIGRATIONS_DIR` takes precedence so a packaged deployment can copy
 * the migrations directory somewhere outside the source tree.
 */
export const resolveMigrationsFolder = (override?: string): string => {
  const explicit = override ?? process.env.SLIPMEM_MIGRATIONS_DIR

  if (explicit !== undefined && explicit.length > 0) {
    const folder = resolve(explicit)
    if (!hasMigrationFiles(folder)) {
      throw new MigrationError({
        message: `SLIPMEM_MIGRATIONS_DIR points to "${folder}", but it does not contain a Drizzle migration (expected <name>/migration.sql). Refusing to start with an unmigrated database.`,
      })
    }
    return folder
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = Array.from(
    new Set([...folderCandidates(moduleDirectory), ...folderCandidates(process.cwd())]),
  )
  const folder = candidates.find(hasMigrationFiles)

  if (folder === undefined) {
    throw new MigrationError({
      message: `Could not find the Drizzle migrations folder. Searched:\n${candidates
        .map((candidate) => `  - ${candidate}`)
        .join("\n")}\nSet SLIPMEM_MIGRATIONS_DIR to the directory containing the generated migrations.`,
    })
  }

  return folder
}

const failMigration = (message: string) => new MigrationError({ message })

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const tableInfo = (sql: DatabaseClient, table: string) =>
  Effect.map(
    sql<TableInfoRow>`PRAGMA table_info(${sql(table)})`,
    (rows) => Array.from(rows),
  )

const tableType = (sql: DatabaseClient, table: string) =>
  Effect.map(
    sql<{ readonly type: string }>`
      SELECT type FROM sqlite_master WHERE name = ${table}
    `,
    (rows) => rows[0]?.type,
  )

const describeColumns = (columns: ReadonlyArray<ExpectedColumn>): string =>
  columns
    .map(
      (column) =>
        `${column.name} ${column.type}${column.notNull ? " NOT NULL" : ""}${column.primaryKey ? " PRIMARY KEY" : ""}`,
    )
    .join(", ")

const assertTableSchema = (
  sql: DatabaseClient,
  expected: ExpectedTable,
): Effect.Effect<void, MigrationFailure> =>
  Effect.gen(function* () {
    const kind = yield* tableType(sql, expected.name)

    if (kind === undefined) {
      return yield* failMigration(
        `The database is missing the "${expected.name}" table. It looks like the migration history was lost or the database was partially restored. Refusing to guess the schema; restore a backup or remove the database file to start fresh.`,
      )
    }

    if (kind !== "table") {
      return yield* failMigration(
        `"${expected.name}" exists but is a ${kind}, not a table. Refusing to migrate over an unexpected object.`,
      )
    }

    const actual = yield* tableInfo(sql, expected.name)
    const actualByName = new Map(actual.map((column) => [column.name, column]))
    const expectedNames = expected.columns.map((column) => column.name)
    const actualNames = actual.map((column) => column.name)

    const missing = expectedNames.filter((name) => !actualByName.has(name))
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name))

    if (missing.length > 0 || unexpected.length > 0) {
      return yield* failMigration(
        `The existing "${expected.name}" table does not match the expected note schema. Expected columns: [${expectedNames.join(
          ", ",
        )}]. Found: [${actualNames.join(", ")}]. Refusing to drop, recreate, or silently reinterpret existing data. Back up the database, migrate it manually, or set SLIPMEM_DB_PATH to a new file.`,
      )
    }

    for (const column of expected.columns) {
      const found = actualByName.get(column.name)!
      const actualType = found.type.trim().toUpperCase()

      if (
        actualType !== column.type ||
        (found.notnull === 1) !== column.notNull ||
        (found.pk === 1) !== column.primaryKey
      ) {
        return yield* failMigration(
          `The existing "${expected.name}.${column.name}" column has type ${found.type || "(none)"}${
            found.notnull === 1 ? " NOT NULL" : ""
          }${found.pk === 1 ? " PRIMARY KEY" : ""}; expected ${describeColumns(
            expected.columns.filter((candidate) => candidate.name === column.name),
          )}. Refusing to alter or recreate a populated table automatically.`,
        )
      }
    }
  })

// A missing table is fine before migrations run: it may be the first startup
// or a database left by an older version that only created some tables.
// Existing tables are checked against the frozen bootstrap shape, not the
// post-migration shape, so future migrations can evolve note tables while
// legacy databases still adopt and upgrade through the normal history.
const assertExistingTables = (
  sql: DatabaseClient,
): Effect.Effect<void, MigrationFailure> =>
  Effect.forEach(
    legacyNoteTables,
    (expected) =>
      Effect.gen(function* () {
        const kind = yield* tableType(sql, expected.name)
        if (kind !== undefined) {
          yield* assertTableSchema(sql, expected)
        }
      }),
    { discard: true },
  )

const assertAllTables = (sql: DatabaseClient): Effect.Effect<void, MigrationFailure> =>
  Effect.forEach(noteTables, (expected) => assertTableSchema(sql, expected), {
    discard: true,
  })

const migrationTableColumns = (sql: DatabaseClient) =>
  Effect.map(
    sql<TableInfoRow>`PRAGMA table_info(${sql(migrationsTable)})`,
    (rows) => Array.from(rows),
  )

/**
 * Returns whether the first local migration has already been applied.
 *
 * A database created by the old handwritten bootstrap has note tables but no
 * `__drizzle_migrations` table, so it must be validated before the generated
 * migration adopts it. A database with an unrelated or partially created
 * migration table is treated the same way until the initial migration is
 * actually recorded.
 */
const initialMigrationApplied = (
  sql: DatabaseClient,
  initialMigrationName: string,
): Effect.Effect<boolean, MigrationFailure> =>
  Effect.gen(function* () {
    const kind = yield* tableType(sql, migrationsTable)
    if (kind !== "table") return false

    const columns = yield* migrationTableColumns(sql)
    if (!columns.some((column) => column.name === "name")) return false

    const rows = yield* sql<{ readonly name: string | null }>`
      SELECT name FROM ${sql(migrationsTable)}
    `

    return Array.from(rows).some((row) => row.name === initialMigrationName)
  })

/**
 * Runs the generated Drizzle migrations against the database provided by
 * `SqliteClient`.
 *
 * The whole migration is wrapped in one `BEGIN IMMEDIATE` transaction. This
 * makes two processes starting against the same file serialize instead of
 * racing to create tables, and it keeps the schema check, the DDL, and the
 * migration-history row atomic. `IF NOT EXISTS` in the initial migration makes
 * databases created by the old bootstrap adoptable without losing rows; the
 * pre-check above makes sure those rows really are in the expected shape.
 */
export const runMigrations = (
  options: { readonly migrationsFolder?: string } = {},
): Effect.Effect<void, MigrationFailure, SqliteClientService> =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient

    // Both of these helpers throw synchronously. Map their failures into the
    // effect error channel so callers can handle them as a MigrationError
    // instead of receiving an uncatchable defect.
    const migrationsFolder = yield* Effect.try({
      try: () => resolveMigrationsFolder(options.migrationsFolder),
      catch: (cause) =>
        cause instanceof MigrationError
          ? cause
          : new MigrationError({
              message: `Could not resolve the Drizzle migrations folder: ${errorMessage(cause)}`,
            }),
    })
    const localMigrations = yield* Effect.try({
      try: () => readMigrationFiles({ migrationsFolder }),
      catch: (cause) =>
        new MigrationError({
          message: `Could not read the Drizzle migrations in "${migrationsFolder}": ${errorMessage(cause)}`,
        }),
    })
    const initial = localMigrations[0]

    if (initial === undefined) {
      return yield* failMigration(
        `The migrations folder "${migrationsFolder}" contains no migrations. Refusing to start with an unmigrated database.`,
      )
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const adopted = yield* initialMigrationApplied(sql, initial.name)

        if (!adopted) {
          // Validate every table that already exists before letting the
          // generated CREATE TABLE statements touch the file.
          yield* assertExistingTables(sql)
        }

        const db = yield* SQLiteDrizzle.makeWithDefaults()
        yield* migrate(db, { migrationsFolder }).pipe(
          // Drizzle's legacy-history upgrade throws a plain Error for an
          // unrecognised migration table. Convert that defect into the same
          // actionable failure callers get for the rest of the runner.
          Effect.catchCauseIf(
            (cause) => cause.reasons.some(Cause.isDieReason),
            (cause) =>
              Effect.fail(
                failMigration(
                  `The database could not be migrated safely: ${Cause.pretty(cause)}`,
                ),
              ),
          ),
        )
        yield* assertAllTables(sql)
      }),
    )
  })

const migrationsLayer = Layer.effectDiscard(runMigrations())

/**
 * Provides the note tables by running the checked-in Drizzle migrations on the
 * current `SqliteClient`.
 *
 * The runner is process-agnostic so the web server, the stdio MCP server, and
 * tests all execute exactly the same migration history.
 */
export const makeMigrationsLayer = (
  options: { readonly migrationsFolder?: string } = {},
) =>
  options.migrationsFolder === undefined
    ? migrationsLayer
    : Layer.effectDiscard(runMigrations(options))
