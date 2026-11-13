import { real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const FleetingNoteTable = sqliteTable("fleeting_note", {
  id: text("id").primaryKey().notNull(),
  content: text("content").notNull(),
  created: real("created_at").notNull(),
  updated: real("updated_at").notNull(),
})
