import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { makeApiHandler } from "./app"
import { makeDatabaseLayer } from "./database"
import { MigrationError, resolveMigrationsFolder } from "./migrations"

const withTemporaryDirectory = async <A>(
  run: (directory: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-migration-acceptance-"))

  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const startDatabase = (databasePath: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.asVoid(Layer.build(makeDatabaseLayer(databasePath))),
    ),
  )

const createLegacyBootstrapTables = (db: Database) => {
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

const checkedInMigrationNames = (): ReadonlyArray<string> =>
  readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() }).map(
    (migration) => migration.name,
  )

const appliedMigrationNames = (db: Database): ReadonlyArray<string> =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM __drizzle_migrations ORDER BY id",
    )
    .all()
    .map((row) => row.name)

const tableNames = (db: Database): ReadonlyArray<string> =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name)

test("a fresh database records every checked-in migration", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect([...appliedMigrationNames(db)].sort()).toEqual(
        [...checkedInMigrationNames()].sort(),
      )
    } finally {
      db.close()
    }
  })
})

test("a legacy database is adopted without touching unrelated objects", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      createLegacyBootstrapTables(legacy)
      legacy.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE INDEX fleeting_note_updated_at ON fleeting_note (updated_at);
      `)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-fleeting", "Legacy fleeting", "old thought", 10, 20)
      legacy
        .query(
          "INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-permanent", "Legacy permanent", "old idea", 30, 40)
      legacy
        .query(
          "INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-literature", "Legacy literature", "old quote", "Old book", 50, 60)
      legacy
        .query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .run("theme", "dark")
    } finally {
      legacy.close()
    }

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect([...appliedMigrationNames(db)].sort()).toEqual(
        [...checkedInMigrationNames()].sort(),
      )
      expect(
        db
          .query<{ id: string; updated_at: number }, []>(
            "SELECT id, updated_at FROM fleeting_note",
          )
          .all(),
      ).toEqual([{ id: "legacy-fleeting", updated_at: 20 }])
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
      expect(
        db
          .query<{ key: string; value: string }, []>(
            "SELECT key, value FROM app_settings",
          )
          .all(),
      ).toEqual([{ key: "theme", value: "dark" }])
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'fleeting_note_updated_at'",
          )
          .all(),
      ).toEqual([{ name: "fleeting_note_updated_at" }])
    } finally {
      db.close()
    }
  })
})

test("a note table with an extra column is rejected before any migration runs", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      // A partially applied scope migration, or a hand-edited database, must
      // not be guessed at. The extra column is exactly the kind of drift a
      // future scoped-memory migration could leave behind.
      legacy.exec(`
        CREATE TABLE fleeting_note (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          scope TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
      `)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("drifted", "Do not reinterpret", "keep this", "project:slipmem", 1, 2)
    } finally {
      legacy.close()
    }

    await expect(startDatabase(databasePath)).rejects.toBeInstanceOf(
      MigrationError,
    )

    const db = new Database(databasePath)
    try {
      expect(tableNames(db)).toEqual(["fleeting_note"])
      expect(
        db
          .query<{ id: string; content: string; scope: string }, []>(
            "SELECT id, content, scope FROM fleeting_note",
          )
          .all(),
      ).toEqual([
        { id: "drifted", content: "keep this", scope: "project:slipmem" },
      ])
    } finally {
      db.close()
    }
  })
})

test("the JSON API serves adopted legacy notes and can write new ones", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const legacy = new Database(databasePath)

    try {
      createLegacyBootstrapTables(legacy)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-fleeting", "Legacy fleeting", "old thought", 10, 20)
      legacy
        .query(
          "INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-permanent", "Legacy permanent", "old idea", 30, 40)
      legacy
        .query(
          "INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-literature", "Legacy literature", "old quote", "Old book", 50, 60)
    } finally {
      legacy.close()
    }

    const api = makeApiHandler(databasePath, { disableLogger: true })

    try {
      const listResponse = await api.handler(
        new Request("http://localhost/api/notes"),
      )
      expect(listResponse.status).toBe(200)
      const listed = (await listResponse.json()) as {
        readonly notes: ReadonlyArray<{
          readonly id: string
          readonly type: string
          readonly reference?: string
        }>
      }
      expect(listed.notes.map((note) => note.id)).toEqual([
        "legacy-literature",
        "legacy-permanent",
        "legacy-fleeting",
      ])
      expect(
        listed.notes.find((note) => note.id === "legacy-literature")?.reference,
      ).toBe("Old book")

      const createResponse = await api.handler(
        new Request("http://localhost/api/notes/fleeting", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "After migration",
            content: "written through the API",
          }),
        }),
      )
      expect(createResponse.status).toBe(201)
      expect(await createResponse.json()).toMatchObject({
        type: "fleeting",
        title: "After migration",
      })

      const afterResponse = await api.handler(
        new Request("http://localhost/api/notes"),
      )
      const after = (await afterResponse.json()) as {
        readonly notes: ReadonlyArray<{ readonly id: string }>
      }
      expect(after.notes).toHaveLength(4)
    } finally {
      await api.dispose()
    }

    const db = new Database(databasePath)
    try {
      // Reading and writing through the adopted database must not append
      // duplicate history rows.
      expect([...appliedMigrationNames(db)].sort()).toEqual(
        [...checkedInMigrationNames()].sort(),
      )
    } finally {
      db.close()
    }
  })
})
