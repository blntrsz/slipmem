export {
  makeNoteDatabaseLayer,
  NoteDatabaseLive,
  NoteDatabaseService,
  type NoteDatabase,
  type NoteDatabaseConfig,
} from "./note-database"

export {
  FleetingNoteNotFound,
  FleetingNoteService,
} from "./fleeting-note/fleeting-note.service"
export { SQLiteFleetingNoteService } from "./fleeting-note/sqlite-fleeting-note.service"

export {
  LiteratureNoteNotFound,
  LiteratureNoteService,
} from "./literature-note/literature-note.service"
export { SQLiteLiteratureNoteService } from "./literature-note/sqlite-literature-note.service"

export {
  PermanentNoteNotFound,
  PermanentNoteService,
} from "./permanent-note/permanent-note.service"
export { SQLitePermanentNoteService } from "./permanent-note/sqlite-permanent-note.service"

export { NoteService } from "./note/note.service"
export { SQLiteNoteService } from "./note/SQLite-note.service"

export {
  DEFAULT_SEARCH_LIMIT,
  AllowAllSearchScopeFilterLive,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  SearchScopeFilter,
  SearchService,
  type SearchField,
  type SearchInput,
  type SearchMatch,
  type SearchResult,
  type SearchScope,
  type SearchScopeFilterShape,
  type SearchShape,
} from "./search/search.service"
export {
  SQLiteSearchService,
  UnscopedSQLiteSearchService,
} from "./search/SQLite-search.service"
