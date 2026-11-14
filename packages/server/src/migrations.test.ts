import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { makeDatabaseLayer } from "./database"
import {
  makeMigrationsLayer,
  MigrationError,
  resolveMigrationsFolder,
} from "./migrations"

const createOldBootstrapTables = (db: Database) => {
  db.exec(`
    CREATE TABLE fleeting_note (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );

    CREATE TABLE permanent_note (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );

    CREATE TABLE literature_note (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      reference TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `)
}

const withTemporaryDirectory = async <A>(
  run: (directory: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-migrations-"))

  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const startDatabase = (databasePath: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.asVoid(
        Layer.build(
          makeDatabaseLayer(databasePath),
        ),
      ),
    ),
  )

const noteTableNames = ["fleeting_note", "literature_note", "permanent_note"]

const tableNames = (db: Database): ReadonlyArray<string> =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name)

const migrationCount = (db: Database): number =>
  db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM __drizzle_migrations",
    )
    .get()!.count

test("a fresh database gets every note table and one migration record", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect(tableNames(db)).toEqual(
        [...noteTableNames, "__drizzle_migrations"].sort(),
      )
      expect(migrationCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })
})

test("repeated startup is idempotent and does not lose notes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")

    await startDatabase(databasePath)

    const first = new Database(databasePath)
    try {
      first
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("kept", "Kept", "still here", 1, 2)
    } finally {
      first.close()
    }

    await startDatabase(databasePath)
    await startDatabase(databasePath)

    const second = new Database(databasePath)
    try {
      expect(migrationCount(second)).toBe(1)
      expect(
        second
          .query<{ id: string; title: string }, []>(
            "SELECT id, title FROM fleeting_note",
          )
          .all(),
      ).toEqual([{ id: "kept", title: "Kept" }])
    } finally {
      second.close()
    }
  })
})

test("adopts a populated database created by the old bootstrap", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      createOldBootstrapTables(legacy)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-fleeting", "Legacy fleeting", "old thought", 10, 20)
      legacy
        .query(
          "INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-literature", "Legacy literature", "old quote", "Old book", 30, 40)
      legacy
        .query(
          "INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-permanent", "Legacy permanent", "old idea", 50, 60)
    } finally {
      legacy.close()
    }

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect(migrationCount(db)).toBe(1)
      expect(
        db
          .query<{ id: string; title: string }, []>(
            "SELECT id, title FROM fleeting_note ORDER BY id",
          )
          .all(),
      ).toEqual([{ id: "legacy-fleeting", title: "Legacy fleeting" }])
      expect(
        db
          .query<{ id: string; reference: string }, []>(
            "SELECT id, reference FROM literature_note",
          )
          .all(),
      ).toEqual([{ id: "legacy-literature", reference: "Old book" }])
      expect(
        db
          .query<{ id: string }, []>("SELECT id FROM permanent_note")
          .all(),
      ).toEqual([{ id: "legacy-permanent" }])
    } finally {
      db.close()
    }
  })
})

test("adds missing tables to a partially created legacy database", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      legacy.exec(`
        CREATE TABLE fleeting_note (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
      `)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("partial", "Partial", "kept", 1, 2)
    } finally {
      legacy.close()
    }

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect(tableNames(db)).toEqual(
        [...noteTableNames, "__drizzle_migrations"].sort(),
      )
      expect(migrationCount(db)).toBe(1)
      expect(
        db
          .query<{ id: string }, []>("SELECT id FROM fleeting_note")
          .all(),
      ).toEqual([{ id: "partial" }])
    } finally {
      db.close()
    }
  })
})

test("refuses to adopt an existing table with an unexpected schema", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      legacy.exec(`
        CREATE TABLE fleeting_note (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
      `)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("incompatible", "Do not lose me", 1, 2)
    } finally {
      legacy.close()
    }

    await expect(startDatabase(databasePath)).rejects.toBeInstanceOf(MigrationError)

    const db = new Database(databasePath)
    try {
      expect(tableNames(db)).toEqual(["fleeting_note"])
      expect(
        db
          .query<{ id: string; title: string }, []>(
            "SELECT id, title FROM fleeting_note",
          )
          .all(),
      ).toEqual([{ id: "incompatible", title: "Do not lose me" }])
    } finally {
      db.close()
    }
  })
})

test("refuses to trust migration history when the note tables are missing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const [initial] = readMigrationFiles({
      migrationsFolder: resolveMigrationsFolder(),
    })
    const db = new Database(databasePath)

    try {
      db.exec(`
        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        );
      `)
      db.query(
        "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
      ).run(initial!.hash, initial!.folderMillis, initial!.name, new Date().toISOString())
    } finally {
      db.close()
    }

    await expect(startDatabase(databasePath)).rejects.toBeInstanceOf(MigrationError)
  })
})

test("fails clearly when the configured migrations folder is invalid", async () => {
  await withTemporaryDirectory(async (directory) => {
    const program = Effect.scoped(
      Effect.asVoid(
        Layer.build(
          makeMigrationsLayer({ migrationsFolder: join(directory, "missing") }).pipe(
            Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
          ),
        ),
      ),
    )

    const exit = await Effect.runPromiseExit(program)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons
          .filter(Cause.isFailReason)
          .map((reason) => reason.error),
      ).toEqual([expect.any(MigrationError)])
    }
  })
})

test("refuses a modern migration history that does not match the bundled migrations", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const db = new Database(databasePath)

    try {
      db.exec(`
        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        );
      `)
      db.query(
        "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
      ).run("foreign-hash", 1, "some_other_migration", new Date().toISOString())
    } finally {
      db.close()
    }

    await expect(startDatabase(databasePath)).rejects.toBeInstanceOf(MigrationError)

    const after = new Database(databasePath)
    try {
      expect(tableNames(after)).toEqual(["__drizzle_migrations"])
      expect(
        after
          .query<{ name: string }, []>(
            "SELECT name FROM __drizzle_migrations ORDER BY id",
          )
          .all(),
      ).toEqual([{ name: "some_other_migration" }])
    } finally {
      after.close()
    }
  })
})

test("converts an unmatched legacy migration row into a MigrationError", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const db = new Database(databasePath)

    try {
      db.exec(`
        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric
        );
      `)
      db.query(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      ).run("unknown-hash", 1)
    } finally {
      db.close()
    }

    await expect(startDatabase(databasePath)).rejects.toBeInstanceOf(MigrationError)

    const after = new Database(databasePath)
    try {
      expect(tableNames(after)).toEqual(["__drizzle_migrations"])
      expect(
        after
          .query<{ name: string }, []>(
            "PRAGMA table_info(__drizzle_migrations)",
          )
          .all()
          .map((column) => column.name),
      ).toEqual(["id", "hash", "created_at"])
    } finally {
      after.close()
    }
  })
})
