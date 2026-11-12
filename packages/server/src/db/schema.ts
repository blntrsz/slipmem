import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Domain's storage protocol is a key-value document store: every aggregate
 * instance, view key and durable queue is one object, and its events, state,
 * receipts and outbox rows are keys within it. SQLite holds one row per key.
 */
export const domainObjects = sqliteTable(
  "domain_objects",
  {
    object: text("object").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.object, table.key] }),
    index("domain_objects_object_idx").on(table.object),
  ],
);

/** The migrations applied to this database, in order. */
export const schemaMigrations = sqliteTable("slipmem_migrations", {
  name: text("name").primaryKey(),
  appliedAt: integer("applied_at").notNull(),
});

export const schema = { domainObjects, schemaMigrations };
