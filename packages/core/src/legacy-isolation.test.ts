import { expect, test } from "bun:test"
import * as core from "./index.js"
import * as legacyMigration from "./legacy/migration.js"
import * as legacySqlite from "./legacy/sqlite.js"

test("legacy SQLite and migration exports are only on explicit subpaths", () => {
  // Guardrail: new code should not be able to reach the retired SQLite CRUD or
  // migration surface through the core root barrel.
  for (const name of [
    "SQLiteNoteService",
    "SQLiteFleetingNoteService",
    "SQLiteLiteratureNoteService",
    "SQLitePermanentNoteService",
    "NoteDatabaseService",
    "makeNoteDatabaseLayer",
    "planMigration",
    "importMigration",
    "getLegacyNote",
    "listLegacyNotes",
  ]) {
    expect(name in core).toBe(false)
  }

  expect(legacySqlite.SQLiteNoteService).toBeDefined()
  expect(legacySqlite.NoteDatabaseService).toBeDefined()
  expect(legacyMigration.planMigration).toBeDefined()
  expect(legacyMigration.importMigration).toBeDefined()
  expect(legacyMigration.listLegacyNotes).toBeDefined()
})
