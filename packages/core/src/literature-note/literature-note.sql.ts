import { real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"

// Timestamps are Unix epoch milliseconds stored as REAL.
//
// These defaults are applied at runtime by Drizzle and are not emitted into SQL
// migrations. A migration that creates this table must define equivalent
// defaults, and adding the NOT NULL `title` or `reference` columns to an
// existing table needs a backfill (or a temporary default).
const now = () => Date.now()
const newId = () => crypto.randomUUID() as LiteratureNote.ID

export const LiteratureNoteTable = sqliteTable("literature_note", {
  id: text("id").$type<LiteratureNote.ID>().primaryKey().notNull().$defaultFn(newId),
  title: text("title").notNull(),
  content: text("content").notNull(),
  reference: text("reference").notNull(),
  createdAt: real("created_at").notNull().$defaultFn(now),
  updatedAt: real("updated_at").notNull().$defaultFn(now).$onUpdate(now),
})
