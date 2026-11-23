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
  indexDatabasePath,
  indexExists,
  indexFingerprints,
  INDEX_FILENAME,
  INDEX_SCHEMA_VERSION,
  initializeNoteRoot,
  isPathInside,
  listNoteFilenames,
  listRootEntries,
  LOCK_FILENAME,
  makeMarkdownNoteRepository,
  makeMarkdownSearchIndex,
  MarkdownError,
  MarkdownSearchIndex,
  MarkdownSearchIndexFromRepository,
  MarkdownSearchIndexLive,
  MAX_FRONTMATTER_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_TOKENS,
  MAX_TAG_LIMIT,
  MAX_YAML_ALIASES,
  MarkdownNoteRepository,
  MarkdownNoteRepositoryLive,
  markdownError,
  notePath,
  NOTE_ROOT_DIRECTORY,
  parseFrontmatterYaml,
  parseMarkdownNote,
  readNoteFile,
  renderNoteDocument,
  resolveNoteRoot,
  scanMarkdownRoot,
  splitNoteDocument,
  splitUnknownMetadata,
  STATE_DIRECTORY,
  withRepositoryLock,
  type CheckNoteRootOptions,
  type CheckSeverity,
  type CreateMarkdownNoteInput,
  type DeleteMarkdownNoteOptions,
  type DeleteMarkdownNoteResult,
  type IndexFingerprint,
  type IndexRefreshStats,
  type IndexSnapshotEntry,
  type InitializeNoteRootResult,
  type ListMarkdownNotesInput,
  type ListTagsInput,
  type MarkdownErrorArea,
  type MarkdownErrorCode,
  type MarkdownErrorFields,
  type MarkdownNoteRepositoryShape,
  type MarkdownNoteTitle,
  type MarkdownRepositoryConfig,
  type MarkdownSearchHit,
  type MarkdownSearchIndexConfig,
  type MarkdownSearchIndexShape,
  type MarkdownSearchIndexStatus,
  type MarkdownSearchInput,
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
  type SearchIndexMode,
  type TagSummary,
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
export { MarkdownNoteService } from "./note/markdown-note.service"

export {
  DEFAULT_MIGRATION_SCOPE,
  IMPORT_PROVENANCE_SOURCE,
  inspectLegacyRow,
  LEGACY_NOTE_TABLE_DEFINITIONS,
  legacyNoteTableDefinition,
  MIGRATION_PLAN_SCHEMA,
  MigrationSourceError,
  NOTE_TABLE_NAMES,
  planMigration,
  type LegacyNoteTableDefinition,
  type LegacyRowInspection,
  type LegacyRowInspectionInput,
  type LegacyRowMapping,
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

export {
  defaultMigrationNoteSerializer,
  importMigration,
  MIGRATION_BACKUP_FILENAME,
  MIGRATION_IMPORT_SCHEMA,
  MIGRATION_MANIFEST_FILENAME,
  MIGRATION_QUARANTINE_DIRECTORY,
  MIGRATION_STATE_SUBDIRECTORY,
  MigrationImportError,
  type MigrationBackupReport,
  type MigrationImportCounts,
  type MigrationImportErrorCode,
  type MigrationImportedNote,
  type MigrationImportedNoteStatus,
  type MigrationImportOptions,
  type MigrationImportReport,
  type MigrationImportStatus,
  type MigrationImportWarning,
  type MigrationInterruptedRun,
  type MigrationManifestIssue,
  type MigrationNoteSerializer,
  type MigrationPreservedValue,
  type MigrationQuarantineFile,
  type MigrationQuarantineReport,
  type MigrationRootReport,
  type MigrationSourceCheck,
  type MigrationSourceFileFingerprint,
  type MigrationSqliteValue,
  type MigrationVerificationNote,
  type MigrationVerificationReport,
} from "./migration/migration-import"

export {
  getLegacyNote,
  LEGACY_READ_COMPATIBILITY,
  LEGACY_READ_DEFAULT_LIMIT,
  LEGACY_READ_MAX_ID_LENGTH,
  LEGACY_READ_MAX_LIMIT,
  LEGACY_READ_MAX_OFFSET,
  LEGACY_READ_SCHEMA,
  listLegacyNotes,
  type LegacyGetOptions,
  type LegacyGetReport,
  type LegacyListOptions,
  type LegacyListReport,
  type LegacyReadRow,
  type LegacyReadSource,
  type LegacyReadWarning,
} from "./migration/legacy-read"

// Approval and wiki are additive core services. They consume the narrow parts
// of `MarkdownNoteRepository` they need and do not change SQLite behavior.
export * from "./approval/index"
export * from "./wiki/index"

// Opt-in permanent-memory maintenance. Callers inject the model boundary and
// invoke `run`; nothing here weakens the MCP approval policy.
export * from "./maintenance/index"
export * from "./recall/index"

// Initiative bookkeeping is durable project state, not notes. It consumes
// source files as advisory evidence and never enters the note/recall store.
export * from "./initiative/index"
