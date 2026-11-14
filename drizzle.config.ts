import { defineConfig } from "drizzle-kit"

/**
 * Drizzle Kit configuration for the SQLite note schema.
 *
 * The table definitions live next to the services in @slipmem/core. Both the
 * web server and the stdio MCP server run the migrations generated here
 * through the shared runner in @slipmem/server.
 *
 * Regenerate with:
 *
 *   bun run db:generate
 *
 * Commit both the generated SQL and the generated snapshots: they are the
 * source of truth for every database that has already been migrated.
 *
 * The initial migration was edited after generation to use CREATE TABLE IF NOT
 * EXISTS and explicit NOT NULL primary keys. That is what lets a database
 * created by the old handwritten bootstrap be adopted safely. Do not repeat
 * that edit for future migrations; normal ALTER/CREATE statements are
 * preferable once a database is tracked by Drizzle.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/*/*.sql.ts",
  out: "./packages/server/drizzle",
  dbCredentials: {
    url:
      process.env.SLIPMEM_DB_PATH ??
      "./packages/server/drizzle/scratch.sqlite",
  },
  breakpoints: true,
})
