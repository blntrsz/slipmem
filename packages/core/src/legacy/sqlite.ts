/**
 * Legacy SQLite note CRUD.
 *
 * The Markdown repository is the active source of truth. These services and
 * their database layer remain only for the one-release migration/read
 * compatibility path and for historical tests. Import them through
 * `@slipmem/core/legacy/sqlite`; the core root barrel deliberately does not
 * expose them, so new code cannot accidentally make SQLite note rows a runtime
 * dependency.
 */
export {
  makeNoteDatabaseLayer,
  NoteDatabaseLive,
  NoteDatabaseService,
  type NoteDatabase,
  type NoteDatabaseConfig,
} from "../note-database.js"

export { SQLiteFleetingNoteService } from "../fleeting-note/sqlite-fleeting-note.service.js"
export { SQLiteLiteratureNoteService } from "../literature-note/sqlite-literature-note.service.js"
export { SQLitePermanentNoteService } from "../permanent-note/sqlite-permanent-note.service.js"
export { SQLiteNoteService } from "../note/SQLite-note.service.js"
