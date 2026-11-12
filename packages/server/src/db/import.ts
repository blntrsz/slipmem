import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { domainObjects, schema } from "./schema.ts";

/** One row of the old Effect Cluster Postgres table (`alchemy_domain_objects`). */
export interface DomainObjectRow {
  readonly object: string;
  readonly key: string;
  /** JSON text, as Postgres stored it; parsed JSON is accepted too. */
  readonly value: unknown;
}

export interface ImportOptions {
  /** Only import objects whose id starts with this prefix (for example `SlipMem.`). */
  readonly prefix?: string;
}

/**
 * Copy Domain's key-value rows from an export of the old Postgres table into
 * SQLite. The object ids, keys and JSON values are the same on both platforms,
 * so an existing note box keeps its aggregate history and view snapshots.
 */
export const importDomainObjects = (
  db: BunSQLiteDatabase<typeof schema>,
  rows: ReadonlyArray<DomainObjectRow>,
  options: ImportOptions = {},
): number => {
  let imported = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      if (options.prefix !== undefined && !row.object.startsWith(options.prefix)) continue;
      const value = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
      tx.insert(domainObjects)
        .values({ object: row.object, key: row.key, value })
        .onConflictDoUpdate({
          target: [domainObjects.object, domainObjects.key],
          set: { value },
        })
        .run();
      imported++;
    }
  });
  return imported;
};

/** Parse newline-delimited rows, as `psql -At` prints one JSON object per line. */
export const parseNdjson = (text: string): ReadonlyArray<DomainObjectRow> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DomainObjectRow);
