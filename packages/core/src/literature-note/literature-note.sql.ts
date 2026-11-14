import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import { MemoryScope } from "@slipmem/schemas/memory-scope"
import { Provenance } from "@slipmem/schemas/provenance"

// Timestamps are Unix epoch milliseconds stored as REAL.
//
// `scope` and `provenance` have SQL-level defaults so the scope migration can
// add them to populated legacy tables. The note operations always write the
// resolved values explicitly.
const now = () => Date.now()
const newId = () => crypto.randomUUID() as LiteratureNote.ID

export const LiteratureNoteTable = sqliteTable(
  "literature_note",
  {
    id: text("id").$type<LiteratureNote.ID>().primaryKey().notNull().$defaultFn(newId),
    title: text("title").notNull(),
    content: text("content").notNull(),
    reference: text("reference").notNull(),
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
  (table) => [
    index("literature_note_scope_updated_at_idx").on(table.scope, table.updatedAt),
  ],
)
