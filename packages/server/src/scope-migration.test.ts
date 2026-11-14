import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDatabaseLayer } from "./database"
import { resolveMigrationsFolder } from "./migrations"

const withTemporaryDirectory = async <A>(
  run: (directory: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-scope-migration-"))

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

test("legacy rows are adopted into the default scope with legacy provenance", async () => {
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
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-fleeting", "Legacy", "kept", 1, 2)
      legacy
        .query(
          "INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-literature", "Legacy", "quote", "Book", 3, 4)
      legacy
        .query(
          "INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-permanent", "Legacy", "idea", 5, 6)
    } finally {
      legacy.close()
    }

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect(
        db
          .query<{ id: string; scope: string; provenance: string }, []>(
            "SELECT id, scope, provenance FROM fleeting_note",
          )
          .all(),
      ).toEqual([
        {
          id: "legacy-fleeting",
          scope: "global",
          provenance: '{"source":"legacy"}',
        },
      ])
      expect(
        db
          .query<
            { id: string; scope: string; provenance: string },
            []
          >("SELECT id, scope, provenance FROM literature_note")
          .all(),
      ).toEqual([
        {
          id: "legacy-literature",
          scope: "global",
          provenance: '{"source":"legacy"}',
        },
      ])
      expect(
        db
          .query<
            { id: string; scope: string; provenance: string },
            []
          >("SELECT id, scope, provenance FROM permanent_note")
          .all(),
      ).toEqual([
        {
          id: "legacy-permanent",
          scope: "global",
          provenance: '{"source":"legacy"}',
        },
      ])

      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%scope_updated_at_idx' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "fleeting_note_scope_updated_at_idx",
        "literature_note_scope_updated_at_idx",
        "permanent_note_scope_updated_at_idx",
      ])
    } finally {
      db.close()
    }
  })
})

test("a database at the initial migration is upgraded in place", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "notes.db")
    const [initial] = readMigrationFiles({
      migrationsFolder: resolveMigrationsFolder(),
    })
    const previous = new Database(databasePath)

    try {
      previous.exec(`
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

        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        );
      `)
      previous
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("existing", "Existing", "kept", 1, 2)
      previous
        .query(
          "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          initial!.hash,
          initial!.folderMillis,
          initial!.name,
          new Date().toISOString(),
        )
    } finally {
      previous.close()
    }

    await startDatabase(databasePath)

    const db = new Database(databasePath)
    try {
      expect(
        db
          .query<{ id: string; scope: string; provenance: string }, []>(
            "SELECT id, scope, provenance FROM fleeting_note",
          )
          .all(),
      ).toEqual([
        {
          id: "existing",
          scope: "global",
          provenance: '{"source":"legacy"}',
        },
      ])
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM __drizzle_migrations",
          )
          .get()!.count,
      ).toBe(2)
    } finally {
      db.close()
    }
  })
})

test("a partially scoped database is refused before an ALTER can fail", async () => {
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
          updated_at REAL NOT NULL,
          scope TEXT NOT NULL DEFAULT 'global'
        );
      `)
      legacy
        .query(
          "INSERT INTO fleeting_note (id, title, content, created_at, updated_at, scope) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("partial", "Partial", "kept", 1, 2, "project:alpha")
    } finally {
      legacy.close()
    }

    await expect(startDatabase(databasePath)).rejects.toMatchObject({
      _tag: "MigrationError",
    })

    const db = new Database(databasePath)
    try {
      expect(
        db
          .query<{ id: string; scope: string }, []>(
            "SELECT id, scope FROM fleeting_note",
          )
          .all(),
      ).toEqual([{ id: "partial", scope: "project:alpha" }])
    } finally {
      db.close()
    }
  })
})
