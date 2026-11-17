export {
  makeNoteDatabaseLayer,
  NoteDatabaseLive,
  NoteDatabaseService,
  type NoteDatabase,
  type NoteDatabaseConfig,
} from "./note-database"

export {
  createMarkdownNoteDocument,
  MarkdownError,
  MAX_FRONTMATTER_BYTES,
  MAX_YAML_ALIASES,
  markdownError,
  parseFrontmatterYaml,
  parseMarkdownNote,
  renderNoteDocument,
  splitNoteDocument,
  splitUnknownMetadata,
  type MarkdownErrorArea,
  type MarkdownErrorCode,
  type MarkdownErrorFields,
  type NoteFrontmatter,
  type ParsedMarkdownNote,
  type ParseMarkdownNoteInput,
  type RenderNoteDocumentInput,
} from "./markdown/index"


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
  DEFAULT_MIGRATION_SCOPE,
  IMPORT_PROVENANCE_SOURCE,
  MIGRATION_PLAN_SCHEMA,
  MigrationSourceError,
  NOTE_TABLE_NAMES,
  planMigration,
  type MigrationFilenameCollision,
  type MigrationIssueCode,
  type MigrationIssueProblem,
  type MigrationIssueSeverity,
  type MigrationNotePreservation,
  type MigrationPlan,
  type MigrationPlanCounts,
  type MigrationPlanIssue,
  type MigrationPlanOptions,
  type MigrationRowSource,
  type MigrationSourceErrorCode,
  type MigrationSourceInfo,
  type MigrationSourceShape,
  type MigrationSourceTable,
  type MigrationTableShape,
  type NoteTableName,
  type PlannedMigrationNote,
  type PreservedValue,
  type SqliteValue,
} from "./migration/migration-plan"
