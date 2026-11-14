import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import { MemoryScope } from "@slipmem/schemas/memory-scope"
import { Provenance } from "@slipmem/schemas/provenance"

// Timestamps are Unix epoch milliseconds stored as REAL.
//
// These defaults are applied at runtime by Drizzle and are not emitted into SQL
// migrations. A migration that creates this table must define equivalent
// defaults, and adding the NOT NULL `title` column to an existing table needs a
// backfill (or a temporary default).
//
// `scope` and `provenance` have SQL-level defaults so the scope migration can
// add them to populated legacy tables. They are not runtime defaults: the note
// operations always write the resolved values explicitly.
const now = () => Date.now()
const newId = () => crypto.randomUUID() as FleetingNote.ID

export const FleetingNoteTable = sqliteTable(
  "fleeting_note",
  {
    id: text("id").$type<FleetingNote.ID>().primaryKey().notNull().$defaultFn(newId),
    title: text("title").notNull(),
    content: text("content").notNull(),
    scope: text("scope")
      .$type<MemoryScope.Scope>()
      .notNull()
      .default(MemoryScope.DEFAULT_SCOPE),
    provenance: text("provenance")
      .$type<string>()
      .notNull()
      .default(Provenance.LEGACY_JSON),
    createdAt: real("created_at").notNull().$defaultFn(now),
    updatedAt: real("updated_at").notNull().$defaultFn(now).$onUpdate(now),
  },
  (table) => [index("fleeting_note_scope_updated_at_idx").on(table.scope, table.updatedAt)],
)
