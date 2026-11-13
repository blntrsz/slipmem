import { real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"

// Timestamps are Unix epoch milliseconds stored as REAL.
//
// These defaults are applied at runtime by Drizzle and are not emitted into SQL
// migrations. A migration that creates this table must define equivalent
// defaults, and adding the NOT NULL `title` column to an existing table needs a
// backfill (or a temporary default).
const now = () => Date.now()
const newId = () => crypto.randomUUID() as FleetingNote.ID

export const FleetingNoteTable = sqliteTable("fleeting_note", {
  id: text("id").$type<FleetingNote.ID>().primaryKey().notNull().$defaultFn(newId),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: real("created_at").notNull().$defaultFn(now),
  updatedAt: real("updated_at").notNull().$defaultFn(now).$onUpdate(now),
})
