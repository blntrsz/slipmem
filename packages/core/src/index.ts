// The canonical read projection for active Markdown notes. It intentionally
// mirrors the existing wire shape; callers should migrate from the legacy
// `Note.Info` name without changing their JSON output.
export type { NoteProjection } from "@slipmem/schemas/markdown"

export {
  atomicWriteFile,
  checkNoteRoot,
  createMarkdownNoteDocument,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LOCK_STALE_MS,
  defaultBackupDirectory,
  defaultIndexCacheDirectory,
  ensureStateDirectory,
  ensureStateSubdirectory,
  findAncestorNoteRoot,
  findGitRoot,
  indexDatabasePath,
  indexExists,
  indexFileIsCorrupt,
  indexFingerprints,
  INDEX_FILENAME,
  INDEX_SCHEMA_VERSION,
  initializeNoteRoot,
  isIndexCorruptionError,
  isIndexDatabaseMovedError,
  isPathInside,
  listNoteFilenames,
  listRootEntries,
  LOCK_FILENAME,
  makeMarkdownNoteRepository,
  makeMarkdownSearchIndex,
  makeMarkdownSearchIndexResilient,
  MarkdownError,
  MarkdownSearchIndex,
  MarkdownSearchIndexFromRepository,
  MarkdownSearchIndexLive,
  MarkdownSearchIndexResilientFromRepository,
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
  repairCorruptSearchIndex,
  repairSearchIndexCache,
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

export {
  LiteratureNoteNotFound,
  LiteratureNoteService,
} from "./literature-note/literature-note.service"

export {
  PermanentNoteNotFound,
  PermanentNoteService,
} from "./permanent-note/permanent-note.service"

export { NoteService } from "./note/note.service"
export { MarkdownNoteService } from "./note/markdown-note.service"

// Legacy SQLite note CRUD and migration/read compatibility are intentionally
// absent from this barrel. Import them only from `@slipmem/core/legacy/sqlite`
// or `@slipmem/core/legacy/migration`.

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
