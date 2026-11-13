import { real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"

export const FleetingNoteTable = sqliteTable("fleeting_note", {
  id: text("id").$type<FleetingNote.ID>().primaryKey().notNull(),
  content: text("content").notNull(),
  createdAt: real("created_at").notNull(),
  updatedAt: real("updated_at").notNull(),
})
