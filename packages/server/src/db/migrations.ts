import { sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { schema, schemaMigrations } from "./schema.ts";

interface Migration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/**
 * Ordered, append-only migrations. Each runs once, inside a transaction, and
 * is recorded by name. Never edit a migration that has shipped: add another.
 */
export const migrations: ReadonlyArray<Migration> = [
  {
    name: "0001_domain_objects",
    statements: [
      `CREATE TABLE IF NOT EXISTS domain_objects (
        object TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (object, key)
      )`,
      `CREATE INDEX IF NOT EXISTS domain_objects_object_idx ON domain_objects (object)`,
    ],
  },
];

const ensureMigrationTable = `CREATE TABLE IF NOT EXISTS slipmem_migrations (
  name TEXT PRIMARY KEY NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/** Apply every migration this database has not recorded yet. */
export const migrate = (db: BunSQLiteDatabase<typeof schema>): ReadonlyArray<string> => {
  db.run(sql.raw(ensureMigrationTable));
  const applied = new Set(
    db
      .select({ name: schemaMigrations.name })
      .from(schemaMigrations)
      .all()
      .map((row) => row.name),
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    db.transaction((tx) => {
      for (const statement of migration.statements) tx.run(sql.raw(statement));
      tx.insert(schemaMigrations)
        .values({ name: migration.name, appliedAt: Date.now() })
        .run();
    });
    ran.push(migration.name);
  }
  return ran;
};
