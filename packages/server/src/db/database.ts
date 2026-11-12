import { Database as SQLite } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate } from "./migrations.ts";
import { schema } from "./schema.ts";

export interface DatabaseShape {
  readonly filename: string;
  readonly sqlite: SQLite;
  readonly db: BunSQLiteDatabase<typeof schema>;
}

/** The process's one SQLite connection. */
export class Database extends Context.Service<Database, DatabaseShape>()("SlipMem/Database") {}

export interface OpenOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
}

const absolute = (filename: string): string =>
  filename === ":memory:" ? filename : resolve(filename);

/** Open the database, enable durable journaling, and apply migrations. */
export const open = ({ filename }: OpenOptions): DatabaseShape => {
  const path = absolute(filename);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SQLite(path, { create: true });
  // WAL keeps readers and the occasional background writer from blocking each
  // other; one connection still serializes writes through our transaction lock.
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db);
  return { filename: path, sqlite, db };
};

/** The SQLite database as a scoped Layer. The file is closed with the layer. */
export const layer = (options: OpenOptions): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => open(options)),
      (database) =>
        Effect.sync(() => {
          database.sqlite.close();
        }),
    ),
  );

/** The default database location for a process started outside Docker. */
export const defaultFilename = (): string =>
  process.env.SLIPMEM_SQLITE_PATH ?? resolve(process.cwd(), ".slipmem/slipmem.sqlite");
