export {
  makeNoteDatabaseLayer,
  NoteDatabaseLive,
  NoteDatabaseService,
  type NoteDatabase,
  type NoteDatabaseConfig,
} from "./note-database"

export {
  atomicWriteFile,
  checkNoteRoot,
  createMarkdownNoteDocument,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LOCK_STALE_MS,
  defaultBackupDirectory,
  defaultIndexCacheDirectory,
  findAncestorNoteRoot,
  findGitRoot,
  indexFingerprints,
  initializeNoteRoot,
  isPathInside,
  listNoteFilenames,
  listRootEntries,
  LOCK_FILENAME,
  makeMarkdownNoteRepository,
  MarkdownError,
  MAX_FRONTMATTER_BYTES,
  MAX_YAML_ALIASES,
  MarkdownNoteRepository,
  MarkdownNoteRepositoryLive,
  markdownError,
  notePath,
  parseFrontmatterYaml,
  parseMarkdownNote,
  readNoteFile,
  renderNoteDocument,
  resolveNoteRoot,
  scanMarkdownRoot,
  splitNoteDocument,
  splitUnknownMetadata,
  withRepositoryLock,
  type CheckNoteRootOptions,
  type CheckSeverity,
  type CreateMarkdownNoteInput,
  type DeleteMarkdownNoteResult,
  type IndexFingerprint,
  type InitializeNoteRootResult,
  type ListMarkdownNotesInput,
  type MarkdownErrorArea,
  type MarkdownErrorCode,
  type MarkdownErrorFields,
  type MarkdownNoteRepositoryShape,
  type MarkdownNoteTitle,
  type MarkdownRepositoryConfig,
  type NoteCheckIssue,
  type NoteCheckReport,
  type NoteFrontmatter,
  type NoteRootResolution,
  type NoteRootSource,
  type ParsedMarkdownNote,
  type ParseMarkdownNoteInput,
  type RenderNoteDocumentInput,
  type RepositoryEntry,
  type RepositoryScan,
  type ResolveNoteRootOptions,
  type UpdateMarkdownNoteInput,
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
