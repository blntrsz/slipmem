import { Database } from "bun:sqlite"
import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { atomicWriteFile } from "../markdown/atomic.js"
import { MarkdownError } from "../markdown/errors.js"
import {
  renderNoteDocument,
  type RenderNoteDocumentInput,
} from "../markdown/frontmatter.js"
import { withRepositoryLock } from "../markdown/lock.js"
import {
  parseMarkdownNote,
  type ParseMarkdownNoteInput,
  type ParsedMarkdownNote,
} from "../markdown/note-document.js"
import { notePath } from "../markdown/paths.js"
import { scanMarkdownRoot } from "../markdown/repository.js"
import {
  ensureStateDirectory,
  STATE_DIRECTORY,
} from "../markdown/root.js"
import {
  MigrationSourceError,
  planMigration,
  type MigrationPlan,
  type MigrationPlanIssue,
  type PlannedMigrationNote,
  type PreservedValue,
  type SqliteValue,
} from "./migration-plan.js"

/**
 * Imports the read-only migration plan into a Markdown note root.
 *
 * The importer is the write half of the migration. It never repairs, rewrites,
 * or deletes the SQLite source. Every run keeps a consistent source backup and
 * a local audit trail under `<root>/.state/migrations/`, writes valid notes
 * through the shared Markdown serializer and atomic writer, and re-reads every
 * target before reporting success.
 *
 * `importMigration` is deliberately synchronous; the CLI is a one-shot local
 * command and a synchronous API makes the failure/report contract easier to
 * consume. The underlying serializer, parser, and atomic write still come from
 * `@slipmem/core`'s Markdown implementation.
 */
export const MIGRATION_IMPORT_SCHEMA = 1

export const MIGRATION_STATE_SUBDIRECTORY = "migrations"
export const MIGRATION_MANIFEST_FILENAME = "manifest.json"
export const MIGRATION_BACKUP_FILENAME = "source-backup.db"
export const MIGRATION_QUARANTINE_DIRECTORY = "quarantine"

export type MigrationImportStatus = "dry-run" | "imported" | "failed"

export type MigrationImportErrorCode =
  | "root-not-directory"
  | "root-not-empty"
  | "invalid-rows"
  | "serializer-invalid"
  | "write-failed"
  | "verification-failed"
  | "source-changed"
  | "backup-failed"
  | "state-write-failed"
  | "lock-failed"

export type MigrationImportedNoteStatus =
  | "planned"
  | "imported"
  | "skipped-legacy-id"
  | "skipped-conflict"
  | "failed"

export interface MigrationRootReport {
  readonly path: string
  readonly exists: boolean
  readonly directory: boolean
  /** True when entries other than `.state/` exist. */
  readonly nonEmpty: boolean
  /** Direct children at inspection time, including `.state/`. */
  readonly entries: ReadonlyArray<string>
  /** True when a real import would refuse without `merge: true`. */
  readonly mergeRequired: boolean
}

export interface MigrationSourceFileFingerprint {
  readonly path: string
  readonly exists: boolean
  readonly bytes: number
  readonly sha256: string | null
}

export interface MigrationSourceCheck {
  readonly path: string
  readonly before: MigrationSourceFileFingerprint
  readonly after: MigrationSourceFileFingerprint
  readonly walBefore: MigrationSourceFileFingerprint
  readonly walAfter: MigrationSourceFileFingerprint
  /** The source database and its WAL bytes are unchanged. */
  readonly unchanged: boolean
}

export interface MigrationBackupReport {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly verified: boolean
  readonly integrity: string
  readonly tableCounts: Readonly<Record<string, number>>
}

export interface MigrationImportedNote {
  readonly legacyId: string
  readonly type: Markdown.NoteType
  readonly filename: string
  readonly targetPath: string
  readonly status: MigrationImportedNoteStatus
  readonly sourceRowHash: string
  readonly plannedContentHash: string
  /** SHA-256 of the rendered Markdown file, once it has been prepared. */
  readonly expectedFileHash: string | null
  /** SHA-256 read back from the target file. */
  readonly actualFileHash: string | null
  readonly existingId?: string
  readonly existingPath?: string
  /** Set when the source body differs from the canonical Markdown body. */
  readonly sourceBody?: string
  readonly problems: ReadonlyArray<string>
}

export interface MigrationVerificationNote {
  readonly legacyId: string
  readonly filename: string
  readonly expectedFileHash: string | null
  readonly actualFileHash: string | null
  readonly parsed: boolean
  readonly ok: boolean
  readonly problems: ReadonlyArray<string>
}

export interface MigrationVerificationReport {
  /** False for a dry run, which renders no target files. */
  readonly verified: boolean
  readonly ok: boolean
  readonly expectedNotes: number
  readonly writtenNotes: number
  readonly skippedNotes: number
  readonly parsedNotes: number
  readonly missing: ReadonlyArray<string>
  readonly mismatched: ReadonlyArray<string>
  readonly unexpected: ReadonlyArray<string>
  readonly noteCountBefore: number
  readonly noteCountAfter: number
  readonly notes: ReadonlyArray<MigrationVerificationNote>
}

export interface MigrationQuarantineFile {
  readonly path: string
  readonly table: string
  readonly rowIndex: number
  readonly legacyId: string | null
}

export interface MigrationQuarantineReport {
  readonly directory: string | null
  readonly count: number
  readonly files: ReadonlyArray<MigrationQuarantineFile>
}

export interface MigrationImportWarning {
  readonly code: string
  readonly message: string
  readonly legacyId?: string
  readonly table?: string
  readonly rowIndex?: number
}

export interface MigrationImportCounts {
  readonly sourceRows: number
  readonly plannedNotes: number
  readonly writtenNotes: number
  readonly skippedNotes: number
  readonly failedNotes: number
  readonly malformedRows: number
  readonly quarantinedRows: number
  readonly collisions: number
  readonly sourceErrors: number
  readonly sourceWarnings: number
  readonly importerWarnings: number
}

export interface MigrationImportReport {
  readonly schema: typeof MIGRATION_IMPORT_SCHEMA
  readonly status: MigrationImportStatus
  readonly ok: boolean
  readonly dryRun: boolean
  readonly merge: boolean
  readonly startedAt: string
  readonly completedAt: string
  readonly root: MigrationRootReport
  readonly plan: MigrationPlan
  readonly sourceCheck: MigrationSourceCheck
  readonly backup: MigrationBackupReport | null
  readonly runDirectory: string | null
  readonly manifestPath: string | null
  readonly quarantine: MigrationQuarantineReport
  readonly notes: ReadonlyArray<MigrationImportedNote>
  readonly verification: MigrationVerificationReport
  readonly counts: MigrationImportCounts
  readonly warnings: ReadonlyArray<MigrationImportWarning>
  readonly error: { readonly code: MigrationImportErrorCode; readonly message: string } | null
}

export interface MigrationNoteSerializer {
  readonly render: (input: RenderNoteDocumentInput) => string
  readonly parse: (
    input: ParseMarkdownNoteInput,
  ) => Effect.Effect<ParsedMarkdownNote, MarkdownError>
}

export interface MigrationImportOptions {
  /** Path to the SQLite database. The source is opened read-only. */
  readonly databasePath: string
  /** Target note root. Defaults to `.slipmem` in the working directory. */
  readonly noteRoot?: string
  /** Permit importing into a root that already contains other entries. */
  readonly merge?: boolean
  /** Plan and report without creating, backing up, or writing anything. */
  readonly dryRun?: boolean
  /** Injectable clock for deterministic run ids and manifests in tests. */
  readonly now?: () => number
  /** Narrow serializer seam; defaults to the shared Markdown implementation. */
  readonly serializer?: MigrationNoteSerializer
}

/** Raised when a real import cannot complete. The report is always attached. */
export class MigrationImportError extends Error {
  readonly code: MigrationImportErrorCode
  readonly report: MigrationImportReport | null
  readonly cause: unknown

  constructor(
    code: MigrationImportErrorCode,
    message: string,
    report: MigrationImportReport | null = null,
    cause?: unknown,
  ) {
    super(message)
    this.name = "MigrationImportError"
    this.code = code
    this.report = report
    this.cause = cause
  }
}

export const defaultMigrationNoteSerializer: MigrationNoteSerializer = {
  render: (input) => renderNoteDocument(input),
  parse: (input) => parseMarkdownNote(input),
}

interface PortableObject {
  [key: string]: unknown
}

/**
 * JSON-safe representation of SQLite/JSON values. Text is never shortened;
 * bigints and blobs get explicit tags so a manifest or quarantine file can be
 * decoded without guessing.
 */
const toPortable = (value: unknown): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $number: String(value) }
  }
  if (typeof value === "bigint") return { $bigint: value.toString() }
  if (value instanceof Uint8Array) {
    return { $base64: Buffer.from(value).toString("base64") }
  }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map(toPortable)
  if (typeof value === "object") {
    const object: PortableObject = {}
    for (const [key, entry] of Object.entries(value)) {
      object[key] = toPortable(entry)
    }
    return object
  }
  return String(value)
}

const stableJson = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (typeof value === "object") {
    const object = value as PortableObject
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const jsonText = (value: unknown): string =>
  `${JSON.stringify(toPortable(value), null, 2)}\n`

const sha256String = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

/** Converts a SQLite INTEGER count read with safeIntegers enabled. */
const countSqliteInteger = (value: unknown): number => {
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number" && Number.isFinite(value)) return value
  return 0
}

const canonicalBody = (body: string): string =>
  body.trim().replace(/\r\n?/g, "\n")

const canonicalReference = (reference: string | undefined): string =>
  (reference ?? "").trim()

const timestampOf = (millis: number): string =>
  Markdown.toUtcTimestamp(millis).isoTimestamp

const fileFingerprint = (
  path: string,
): MigrationSourceFileFingerprint => {
  if (!existsSync(path)) {
    return { path, exists: false, bytes: 0, sha256: null }
  }
  const stats = statSync(path)
  return {
    path,
    exists: true,
    bytes: stats.size,
    sha256: sha256File(path),
  }
}

const sameFingerprint = (
  left: MigrationSourceFileFingerprint,
  right: MigrationSourceFileFingerprint,
): boolean =>
  left.exists === right.exists &&
  left.bytes === right.bytes &&
  left.sha256 === right.sha256

const inspectRoot = (root: string): MigrationRootReport => {
  let stats
  try {
    stats = lstatSync(root)
  } catch {
    return {
      path: root,
      exists: false,
      directory: false,
      nonEmpty: false,
      entries: [],
      mergeRequired: false,
    }
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return {
      path: root,
      exists: true,
      directory: false,
      nonEmpty: true,
      entries: [],
      mergeRequired: true,
    }
  }

  const entries = readdirSync(root).sort()
  const nonEmpty = entries.some((entry) => entry !== STATE_DIRECTORY)
  return {
    path: root,
    exists: true,
    directory: true,
    nonEmpty,
    entries,
    mergeRequired: nonEmpty,
  }
}

const noteFilenames = (root: string): ReadonlySet<string> => {
  try {
    return new Set(
      readdirSync(root).filter((entry) => Markdown.isNoteFilename(entry)),
    )
  } catch {
    return new Set()
  }
}

const writeStateText = (
  path: string,
  content: string,
  overwrite: boolean,
): void => {
  Effect.runSync(atomicWriteFile(path, content, { overwrite, mode: 0o600 }))
}

const parseWith = (
  serializer: MigrationNoteSerializer,
  input: ParseMarkdownNoteInput,
): ParsedMarkdownNote => Effect.runSync(serializer.parse(input))

const readWith = (
  serializer: MigrationNoteSerializer,
  path: string,
  content: string,
): ParsedMarkdownNote => parseWith(serializer, { path, content })

const unknownMetadataFor = (
  note: PlannedMigrationNote,
): Readonly<Record<string, unknown>> => {
  const unknown: Record<string, unknown> = {
    // Scope is a compatibility field from the scoped-memory contract. Writing
    // it explicitly keeps `global` and future namespaces visible in the file.
    scope: note.preservation.scope,
  }

  const extras = note.preservation.provenanceExtras
  if (Object.keys(extras).length > 0) {
    unknown["legacyProvenance"] = toPortable(extras)
  }

  const columns = note.preservation.columns
  if (Object.keys(columns).length > 0) {
    unknown["legacyColumns"] = toPortable(columns)
  }

  return unknown
}

const expectedMetadataIssues = (
  parsed: ParsedMarkdownNote,
  note: PlannedMigrationNote,
): Array<string> => {
  const problems: Array<string> = []
  const metadata = parsed.metadata
  if (metadata.id !== note.metadata.id) {
    problems.push(`id ${metadata.id} != ${note.metadata.id}`)
  }
  if (metadata.type !== note.metadata.type) {
    problems.push(`type ${metadata.type} != ${note.metadata.type}`)
  }
  if (metadata.title !== note.metadata.title) {
    problems.push(`title ${JSON.stringify(metadata.title)} != ${JSON.stringify(note.metadata.title)}`)
  }
  if (metadata.createdAt !== note.metadata.createdAt) {
    problems.push(`createdAt ${metadata.createdAt} != ${note.metadata.createdAt}`)
  }
  if (metadata.updatedAt !== note.metadata.updatedAt) {
    problems.push(`updatedAt ${metadata.updatedAt} != ${note.metadata.updatedAt}`)
  }
  if (metadata.legacyId !== note.legacyId) {
    problems.push(`legacyId ${metadata.legacyId} != ${note.legacyId}`)
  }
  if (
    canonicalReference(metadata.reference) !==
    canonicalReference(note.metadata.reference)
  ) {
    problems.push("reference differs from the planned value")
  }
  if (
    canonicalBody(parsed.body) !== canonicalBody(note.body)
  ) {
    problems.push("body differs from the planned source content")
  }
  return problems
}

const sameImportedNote = (
  existing: ParsedMarkdownNote,
  note: PlannedMigrationNote,
): boolean =>
  existing.metadata.type === note.metadata.type &&
  existing.metadata.title === note.metadata.title &&
  existing.metadata.createdAt === note.metadata.createdAt &&
  existing.metadata.updatedAt === note.metadata.updatedAt &&
  existing.metadata.legacyId === note.legacyId &&
  canonicalReference(existing.metadata.reference) ===
    canonicalReference(note.metadata.reference) &&
  canonicalBody(existing.body) === canonicalBody(note.body)

const inspectionMergeWarning = (
  root: MigrationRootReport,
  merge: boolean,
): ReadonlyArray<MigrationImportWarning> =>
  root.nonEmpty && !merge
    ? [
        {
          code: "merge-required",
          message:
            "The note root is not empty. A real import requires merge: true; a dry run only reports the conflict.",
        },
      ]
    : []

const bodyWarnings = (
  plan: MigrationPlan,
): ReadonlyArray<MigrationImportWarning> =>
  plan.notes.flatMap((note) =>
    canonicalBody(note.body) === note.body
      ? []
      : [
          {
            code: "body-normalized",
            message:
              "The source body has leading/trailing whitespace or CR line endings. The canonical Markdown body is preserved in the note file; the original source body is recorded in the migration manifest.",
            legacyId: note.legacyId,
            table: note.source.table,
            rowIndex: note.source.rowIndex,
          },
        ],
  )

const emptyVerification = (
  expectedNotes: number,
  noteCount: number,
  verified: boolean,
): MigrationVerificationReport => ({
  verified,
  ok: true,
  expectedNotes,
  writtenNotes: 0,
  skippedNotes: 0,
  parsedNotes: 0,
  missing: [],
  mismatched: [],
  unexpected: [],
  noteCountBefore: noteCount,
  noteCountAfter: noteCount,
  notes: [],
})

const baseNote = (note: PlannedMigrationNote): MigrationImportedNote => ({
  legacyId: note.legacyId,
  type: note.type,
  filename: note.filename,
  targetPath: note.targetPath,
  status: "planned",
  sourceRowHash: note.sourceRowHash,
  plannedContentHash: note.contentHash,
  expectedFileHash: null,
  actualFileHash: null,
  problems: [],
})

const createSourceBackup = (
  databasePath: string,
  backupPath: string,
  plan: MigrationPlan,
): MigrationBackupReport => {
  const sourceSize = statSync(databasePath).size
  const walPath = `${databasePath}-wal`
  if (sourceSize === 0 && !existsSync(walPath)) {
    // A zero-byte SQLite file has no pages to copy. VACUUM INTO refuses to
    // write from a read-only empty database, so an exact byte copy is the
    // consistent backup.
    copyFileSync(databasePath, backupPath)
  } else {
    // `PRAGMA query_only` blocks `VACUUM INTO` on a non-WAL source, so the
    // read-only connection flag is the write guard here. VACUUM INTO still
    // reads a single consistent snapshot, including uncheckpointed WAL frames.
    const database = new Database(databasePath, { readonly: true })
    try {
      database.prepare("VACUUM INTO ?").run(backupPath)
    } finally {
      database.close()
    }
  }

  const bytes = statSync(backupPath).size
  const sha256 = sha256File(backupPath)
  const verify = new Database(backupPath, {
    readonly: true,
    safeIntegers: true,
  })
  let integrity = ""
  const tableCounts: Record<string, number> = {}
  try {
    integrity =
      verify
        .query<{ readonly integrity_check: string }, []>(
          "PRAGMA integrity_check",
        )
        .get()?.integrity_check ?? ""
    if (integrity !== "ok") {
      throw new Error(
        `The source backup failed SQLite integrity_check: ${integrity || "(empty)"}.`,
      )
    }

    for (const table of plan.source.tables) {
      const count = countSqliteInteger(
        verify
          .query<{ readonly count: unknown }, []>(
            `SELECT COUNT(*) AS count FROM "${table.name}"`,
          )
          .get()?.count,
      )
      tableCounts[table.name] = count
      if (count !== table.rowCount) {
        throw new Error(
          `The source backup has ${count} row(s) in "${table.name}", expected ${table.rowCount}.`,
        )
      }
    }
  } finally {
    verify.close()
  }

  return {
    path: backupPath,
    bytes,
    sha256,
    verified: true,
    integrity,
    tableCounts,
  }
}

const uniqueRunId = (migrationsDirectory: string, nowMs: number): string => {
  const base = Markdown.toUtcTimestamp(nowMs).filenamePrefix
  let candidate = base
  for (let suffix = 2; existsSync(join(migrationsDirectory, candidate)); suffix++) {
    candidate = `${base}-${suffix}`
  }
  return candidate
}

const sanitizeFilenamePart = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)
  return sanitized.length === 0 ? "no-id" : sanitized
}

interface QuarantineInput {
  readonly directory: string
  readonly plan: MigrationPlan
}

const writeQuarantine = ({
  directory,
  plan,
}: QuarantineInput): MigrationQuarantineReport => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const files: Array<MigrationQuarantineFile> = []
  const index: Array<Record<string, unknown>> = []

  for (const issue of plan.issues) {
    if (issue.severity !== "error" || issue.row === null || issue.table === null) {
      continue
    }
    const rowIndex = issue.rowIndex ?? 0
    const filename = `${issue.table}-row-${rowIndex}-${sanitizeFilenamePart(
      issue.legacyId ?? "no-id",
    )}.json`
    const path = join(directory, filename)
    const document = {
      schema: MIGRATION_IMPORT_SCHEMA,
      kind: "slipmem-migration-invalid-row",
      table: issue.table,
      rowIndex: issue.rowIndex,
      legacyId: issue.legacyId,
      severity: issue.severity,
      problems: issue.problems,
      row: issue.row,
    }
    writeStateText(path, jsonText(document), false)
    files.push({
      path,
      table: issue.table,
      rowIndex,
      legacyId: issue.legacyId,
    })
    index.push({
      file: filename,
      table: issue.table,
      rowIndex: issue.rowIndex,
      legacyId: issue.legacyId,
      problems: issue.problems,
    })
  }

  writeStateText(
    join(directory, "index.json"),
    jsonText({
      schema: MIGRATION_IMPORT_SCHEMA,
      kind: "slipmem-migration-quarantine-index",
      count: files.length,
      files: index,
    }),
    false,
  )

  return { directory, count: files.length, files }
}

interface ManifestInput {
  readonly runId: string
  readonly createdAt: string
  readonly status: "running" | "imported" | "failed"
  readonly root: MigrationRootReport
  readonly plan: MigrationPlan
  readonly merge: boolean
  readonly backup: MigrationBackupReport | null
  readonly counts: MigrationImportCounts
  readonly notes: ReadonlyArray<MigrationImportedNote>
  readonly verification: MigrationVerificationReport
  readonly sourceCheck: MigrationSourceCheck
  readonly warnings: ReadonlyArray<MigrationImportWarning>
  readonly error: { readonly code: MigrationImportErrorCode; readonly message: string } | null
  readonly quarantine: MigrationQuarantineReport
}

const manifestDocument = (input: ManifestInput): Record<string, unknown> => ({
  schema: MIGRATION_IMPORT_SCHEMA,
  kind: "slipmem-migration-manifest",
  runId: input.runId,
  createdAt: input.createdAt,
  status: input.status,
  root: input.root,
  merge: input.merge,
  source: input.plan.source,
  planHash: input.plan.hash,
  planCounts: input.plan.counts,
  backup: input.backup,
  counts: input.counts,
  quarantine: input.quarantine,
  notes: input.notes,
  issues: input.plan.issues,
  collisions: input.plan.collisions,
  verification: input.verification,
  sourceCheck: input.sourceCheck,
  warnings: input.warnings,
  error: input.error,
})

interface ImportContext {
  readonly root: string
  readonly plan: MigrationPlan
  readonly merge: boolean
  runDirectory: string | null
  manifestPath: string | null
  backup: MigrationBackupReport | null
  quarantine: MigrationQuarantineReport
  notes: ReadonlyArray<MigrationImportedNote>
  verification: MigrationVerificationReport
  sourceCheck: MigrationSourceCheck
  warnings: ReadonlyArray<MigrationImportWarning>
  counts: MigrationImportCounts
  error: { readonly code: MigrationImportErrorCode; readonly message: string } | null
}

const buildReport = (
  context: ImportContext,
  input: {
    readonly status: MigrationImportStatus
    readonly ok: boolean
    readonly dryRun: boolean
    readonly startedAt: string
    readonly completedAt: string
    readonly root: MigrationRootReport
  },
): MigrationImportReport => ({
  schema: MIGRATION_IMPORT_SCHEMA,
  status: input.status,
  ok: input.ok,
  dryRun: input.dryRun,
  merge: context.merge,
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  root: input.root,
  plan: context.plan,
  sourceCheck: context.sourceCheck,
  backup: context.backup,
  runDirectory: context.runDirectory,
  manifestPath: context.manifestPath,
  quarantine: context.quarantine,
  notes: context.notes,
  verification: context.verification,
  counts: context.counts,
  warnings: context.warnings,
  error: context.error,
})

const importCounts = (
  plan: MigrationPlan,
  notes: ReadonlyArray<MigrationImportedNote>,
  warnings: ReadonlyArray<MigrationImportWarning>,
  quarantine: MigrationQuarantineReport,
): MigrationImportCounts => ({
  sourceRows: plan.counts.sourceRows,
  plannedNotes: plan.notes.length,
  writtenNotes: notes.filter((note) => note.status === "imported").length,
  skippedNotes: notes.filter(
    (note) =>
      note.status === "skipped-legacy-id" ||
      note.status === "skipped-conflict",
  ).length,
  failedNotes: notes.filter((note) => note.status === "failed").length,
  malformedRows: plan.counts.malformedRows,
  quarantinedRows: quarantine.count,
  collisions: plan.counts.collisions,
  sourceErrors: plan.counts.errors,
  sourceWarnings: plan.counts.warnings,
  importerWarnings: warnings.length,
})

const emptyQuarantine = (): MigrationQuarantineReport => ({
  directory: null,
  count: 0,
  files: [],
})

/**
 * Plans, imports, verifies, and reports a SQLite-to-Markdown migration.
 *
 * Dry runs only read the source and the existing root. Real imports write
 * `.state/migrations/<run-id>/` with a source backup, manifest, and raw
 * invalid-row quarantine, then import valid rows atomically.
 *
 * Invalid source rows do not prevent valid notes from being written. After
 * verification the function throws `MigrationImportError` with code
 * `"invalid-rows"` and the complete report; the quarantine and manifest remain
 * on disk so no invalid text is lost.
 */
export const importMigration = (
  options: MigrationImportOptions,
): MigrationImportReport => {
  const root = resolve(options.noteRoot ?? ".slipmem")
  const dryRun = options.dryRun === true
  const merge = options.merge === true
  const serializer = options.serializer ?? defaultMigrationNoteSerializer
  const now = options.now ?? Date.now
  const nowMs = now()
  const startedAt = timestampOf(nowMs)

  const initialRoot = inspectRoot(root)
  const initialFilenames = noteFilenames(root)
  const plan = planMigration({
    databasePath: options.databasePath,
    noteRoot: root,
    takenFilenames: initialFilenames,
  })

  const sourceMain = fileFingerprint(options.databasePath)
  const sourceWal = fileFingerprint(`${options.databasePath}-wal`)
  const initialSourceCheck: MigrationSourceCheck = {
    path: options.databasePath,
    before: sourceMain,
    after: sourceMain,
    walBefore: sourceWal,
    walAfter: sourceWal,
    unchanged: sourceMain.sha256 === plan.source.sha256,
  }

  const plannedNotes: ReadonlyArray<MigrationImportedNote> = plan.notes.map(
    (note) => {
      const base = baseNote(note)
      return canonicalBody(note.body) === note.body
        ? base
        : { ...base, sourceBody: note.body }
    },
  )

  let context: ImportContext = {
    root,
    plan,
    merge,
    runDirectory: null,
    manifestPath: null,
    backup: null,
    quarantine: emptyQuarantine(),
    notes: plannedNotes,
    verification: emptyVerification(
      plan.notes.length,
      initialFilenames.size,
      false,
    ),
    sourceCheck: initialSourceCheck,
    warnings: [...bodyWarnings(plan), ...inspectionMergeWarning(initialRoot, merge)],
    counts: importCounts(
      plan,
      plannedNotes,
      [...bodyWarnings(plan), ...inspectionMergeWarning(initialRoot, merge)],
      emptyQuarantine(),
    ),
    error: null,
  }

  const completedAt = timestampOf(now())
  const failureReport = (
    code: MigrationImportErrorCode,
    message: string,
    rootReport: MigrationRootReport,
  ): MigrationImportReport =>
    buildReport(
      { ...context, error: { code, message } },
      {
        status: "failed",
        ok: false,
        dryRun: false,
        startedAt,
        completedAt: timestampOf(now()),
        root: rootReport,
      },
    )

  if (dryRun) {
    return buildReport(context, {
      status: "dry-run",
      ok:
        plan.counts.errors === 0 &&
        (merge || !initialRoot.nonEmpty) &&
        (!initialRoot.exists || initialRoot.directory),
      dryRun: true,
      startedAt,
      completedAt,
      root: initialRoot,
    })
  }

  if (initialRoot.exists && !initialRoot.directory) {
    const message = `The note root "${root}" is not a directory; migration did not write anything.`
    throw new MigrationImportError(
      "root-not-directory",
      message,
      failureReport("root-not-directory", message, initialRoot),
    )
  }

  if (initialRoot.nonEmpty && !merge) {
    const message = `The note root "${root}" is not empty. Re-run with merge: true to add notes without overwriting existing files.`
    throw new MigrationImportError(
      "root-not-empty",
      message,
      failureReport("root-not-empty", message, initialRoot),
    )
  }

  const runImport = (): MigrationImportReport => {
    const rootDirectory = inspectRoot(root)
    if (rootDirectory.exists && !rootDirectory.directory) {
      const message = `The note root "${root}" is not a directory; migration did not write anything.`
      throw new MigrationImportError(
        "root-not-directory",
        message,
        failureReport("root-not-directory", message, rootDirectory),
      )
    }

    mkdirSync(root, { recursive: true, mode: 0o755 })
    const stateDirectory = ensureStateDirectory(root)
    const currentRoot = inspectRoot(root)
    if (currentRoot.nonEmpty && !merge) {
      const message = `The note root "${root}" gained entries before the import could start. Re-run with merge: true to add notes without overwriting existing files.`
      throw new MigrationImportError(
        "root-not-empty",
        message,
        failureReport("root-not-empty", message, currentRoot),
      )
    }

    const takenFilenames = noteFilenames(root)
    const lockedPlan = planMigration({
      databasePath: options.databasePath,
      noteRoot: root,
      takenFilenames,
    })
    const lockedSourceMain = fileFingerprint(options.databasePath)
    const lockedSourceWal = fileFingerprint(`${options.databasePath}-wal`)
    const sourceCheck: MigrationSourceCheck = {
      path: options.databasePath,
      before: lockedSourceMain,
      after: lockedSourceMain,
      walBefore: lockedSourceWal,
      walAfter: lockedSourceWal,
      unchanged: lockedSourceMain.sha256 === lockedPlan.source.sha256,
    }

    const migrationsDirectory = join(
      stateDirectory,
      MIGRATION_STATE_SUBDIRECTORY,
    )
    mkdirSync(migrationsDirectory, { recursive: true, mode: 0o700 })
    const runId = uniqueRunId(migrationsDirectory, nowMs)
    const runDirectory = join(migrationsDirectory, runId)
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
    const manifestPath = join(runDirectory, MIGRATION_MANIFEST_FILENAME)

    let quarantine = emptyQuarantine()
    let warnings: Array<MigrationImportWarning> = [...bodyWarnings(lockedPlan)]
    let noteResults: Array<MigrationImportedNote> = []
    context = {
      ...context,
      plan: lockedPlan,
      runDirectory,
      manifestPath,
      notes: noteResults,
      warnings,
      sourceCheck,
      quarantine,
      verification: emptyVerification(
        lockedPlan.notes.length,
        takenFilenames.size,
        false,
      ),
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }

    const createdAt = timestampOf(now())
    const writeManifest = (
      status: "running" | "imported" | "failed",
      error: { readonly code: MigrationImportErrorCode; readonly message: string } | null,
    ): void => {
      writeStateText(
        manifestPath,
        jsonText(
          manifestDocument({
            runId,
            createdAt,
            status,
            root: currentRoot,
            plan: lockedPlan,
            merge,
            backup: context.backup,
            counts: context.counts,
            notes: context.notes,
            verification: context.verification,
            sourceCheck: context.sourceCheck,
            warnings: context.warnings,
            error,
            quarantine: context.quarantine,
          }),
        ),
        true,
      )
    }

    const fail = (
      code: MigrationImportErrorCode,
      message: string,
      cause?: unknown,
    ): never => {
      const error = { code, message }
      context = {
        ...context,
        error,
        counts: importCounts(
          context.plan,
          context.notes,
          context.warnings,
          context.quarantine,
        ),
      }
      try {
        writeManifest("failed", error)
      } catch (manifestCause) {
        // The in-memory report still carries the failure; do not replace it
        // with a secondary state-write error.
        context = {
          ...context,
          warnings: [
            ...context.warnings,
            {
              code: "manifest-failed",
              message: `Could not update the migration manifest: ${
                manifestCause instanceof Error
                  ? manifestCause.message
                  : String(manifestCause)
              }`,
            },
          ],
        }
      }
      const report = buildReport(context, {
        status: "failed",
        ok: false,
        dryRun: false,
        startedAt,
        completedAt: timestampOf(now()),
        root: inspectRoot(root),
      })
      throw new MigrationImportError(code, message, report, cause)
    }

    let existingScan
    try {
      existingScan = Effect.runSync(scanMarkdownRoot(root))
    } catch (cause) {
      fail(
        "state-write-failed",
        `Could not scan the existing note root before importing: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      )
      throw new Error("unreachable")
    }

    const existingByLegacyId = new Map<string, ParsedMarkdownNote>()
    for (const existing of existingScan.notes) {
      const legacyId = existing.metadata.legacyId
      if (legacyId !== undefined && !existingByLegacyId.has(legacyId)) {
        existingByLegacyId.set(legacyId, existing)
      }
    }

    noteResults = []
    for (const note of lockedPlan.notes) {
      const base = baseNote(note)
      const existing = existingByLegacyId.get(note.legacyId)
      if (existing === undefined) {
        noteResults.push(
          canonicalBody(note.body) === note.body
            ? base
            : { ...base, sourceBody: note.body },
        )
        continue
      }

      const conflict = !sameImportedNote(existing, note)
      if (conflict) {
        warnings.push({
          code: "legacy-id-conflict",
          message: `A note with legacyId "${note.legacyId}" already exists at ${existing.path} with different content. It was not overwritten.`,
          legacyId: note.legacyId,
        })
      }
      noteResults.push({
        ...base,
        status: conflict ? "skipped-conflict" : "skipped-legacy-id",
        existingId: existing.id,
        existingPath: existing.path,
        actualFileHash: existing.contentHash,
        ...(canonicalBody(note.body) === note.body
          ? {}
          : { sourceBody: note.body }),
      })
    }

    context = {
      ...context,
      notes: noteResults,
      warnings,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }

    // Quarantine first so invalid row text survives any later failure.
    try {
      const quarantineDirectory = join(
        runDirectory,
        MIGRATION_QUARANTINE_DIRECTORY,
      )
      quarantine = writeQuarantine({
        directory: quarantineDirectory,
        plan: lockedPlan,
      })
    } catch (cause) {
      fail(
        "state-write-failed",
        `Could not write the invalid-row quarantine: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      )
    }

    context = {
      ...context,
      quarantine,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }
    try {
      writeManifest("running", null)
    } catch (cause) {
      fail(
        "state-write-failed",
        `Could not write the migration manifest: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      )
    }

    interface PreparedNote {
      readonly note: PlannedMigrationNote
      readonly path: string
      readonly content: string
      readonly fileHash: string
      readonly parsed: ParsedMarkdownNote
      readonly index: number
    }

    const prepared: Array<PreparedNote> = []
    for (const [index, result] of noteResults.entries()) {
      if (result.status !== "planned") {
        continue
      }
      const note = lockedPlan.notes.find(
        (candidate) =>
          candidate.legacyId === result.legacyId &&
          candidate.filename === result.filename,
      )
      if (note === undefined) {
        fail(
          "serializer-invalid",
          `Could not match planned note "${result.filename}" back to the migration plan.`,
        )
        throw new Error("unreachable")
      }

      try {
        const path = Effect.runSync(notePath(root, note.metadata.id))
        const unknown = unknownMetadataFor(note)
        const content = serializer.render({
          metadata: note.metadata,
          body: note.body,
          unknown,
        })
        const parsed = readWith(serializer, path, content)
        const problems = expectedMetadataIssues(parsed, note)
        if (
          stableJson(toPortable(parsed.unknown)) !==
          stableJson(toPortable(unknown))
        ) {
          problems.push("preserved frontmatter keys did not round-trip")
        }
        if (problems.length > 0) {
          noteResults[index] = {
            ...result,
            status: "failed",
            problems,
          }
          fail(
            "serializer-invalid",
            `The rendered note "${note.filename}" did not round-trip through the Markdown parser: ${problems.join("; ")}.`,
          )
        }

        prepared.push({
          note,
          path,
          content,
          fileHash: sha256String(content),
          parsed,
          index,
        })
      } catch (cause) {
        if (cause instanceof MigrationImportError) throw cause
        const message =
          cause instanceof MarkdownError
            ? `${cause.code}: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause)
        noteResults[index] = {
          ...result,
          status: "failed",
          problems: [message],
        }
        fail(
          "serializer-invalid",
          `Could not render or validate "${note.filename}": ${message}`,
          cause,
        )
      }
    }

    context = {
      ...context,
      notes: noteResults,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }

    const sourceBeforeWrite = fileFingerprint(options.databasePath)
    const walBeforeWrite = fileFingerprint(`${options.databasePath}-wal`)
    if (
      sourceBeforeWrite.sha256 !== lockedPlan.source.sha256 ||
      !sameFingerprint(walBeforeWrite, sourceCheck.walBefore)
    ) {
      fail(
        "source-changed",
        "The SQLite source changed between planning and backup; no notes were written.",
      )
    }

    try {
      const backupPath = join(runDirectory, MIGRATION_BACKUP_FILENAME)
      const backup = createSourceBackup(
        options.databasePath,
        backupPath,
        lockedPlan,
      )
      context = { ...context, backup }
    } catch (cause) {
      fail(
        "backup-failed",
        `Could not create a consistent source backup: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      )
    }

    const sourceAfterBackup = fileFingerprint(options.databasePath)
    const walAfterBackup = fileFingerprint(`${options.databasePath}-wal`)
    const sourceCheckAfterBackup: MigrationSourceCheck = {
      ...sourceCheck,
      after: sourceAfterBackup,
      walAfter: walAfterBackup,
      unchanged:
        sourceAfterBackup.sha256 === lockedPlan.source.sha256 &&
        sameFingerprint(walAfterBackup, sourceCheck.walBefore),
    }
    context = {
      ...context,
      sourceCheck: sourceCheckAfterBackup,
      counts: importCounts(context.plan, context.notes, context.warnings, context.quarantine),
    }
    if (!sourceCheckAfterBackup.unchanged) {
      fail(
        "source-changed",
        "The SQLite source changed while the backup was being created; no notes were written.",
      )
    }

    const filenamesBefore = noteFilenames(root)
    for (const entry of prepared) {
      try {
        Effect.runSync(
          atomicWriteFile(entry.path, entry.content, {
            overwrite: false,
            mode: 0o644,
          }),
        )
        noteResults[entry.index] = {
          ...noteResults[entry.index]!,
          status: "imported",
          expectedFileHash: entry.fileHash,
          actualFileHash: entry.fileHash,
        }
      } catch (cause) {
        const message =
          cause instanceof MarkdownError
            ? `${cause.code}: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause)
        noteResults[entry.index] = {
          ...noteResults[entry.index]!,
          status: "failed",
          problems: [message],
        }
        fail(
          "write-failed",
          `Could not write "${entry.note.filename}" atomically: ${message}`,
          cause,
        )
      }
    }

    context = {
      ...context,
      notes: noteResults,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }

    const verificationNotes: Array<MigrationVerificationNote> = []
    const missing: Array<string> = []
    const mismatched: Array<string> = []
    const imported = noteResults.filter((note) => note.status === "imported")

    for (const entry of prepared) {
      const result = noteResults[entry.index]!
      const problems: Array<string> = []
      let actualFileHash: string | null = null
      let parsed = false
      try {
        const content = readFileSync(entry.path, "utf8")
        actualFileHash = sha256String(content)
        if (actualFileHash !== entry.fileHash) {
          problems.push("file content hash differs from the rendered note")
          mismatched.push(entry.note.filename)
        } else {
          const reread = readWith(serializer, entry.path, content)
          parsed = true
          const metadataProblems = expectedMetadataIssues(reread, entry.note)
          if (metadataProblems.length > 0) {
            problems.push(...metadataProblems)
          }
        }
      } catch (cause) {
        problems.push(
          cause instanceof MarkdownError
            ? `${cause.code}: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        if (!existsSync(entry.path)) {
          missing.push(entry.note.filename)
        }
      }

      const ok = problems.length === 0
      verificationNotes.push({
        legacyId: entry.note.legacyId,
        filename: entry.note.filename,
        expectedFileHash: entry.fileHash,
        actualFileHash,
        parsed,
        ok,
        problems,
      })
      noteResults[entry.index] = {
        ...result,
        actualFileHash,
        problems: ok ? [] : problems,
      }
    }

    for (const result of noteResults) {
      if (
        result.status !== "skipped-legacy-id" &&
        result.status !== "skipped-conflict"
      ) {
        continue
      }
      const path = result.existingPath
      if (path === undefined) {
        missing.push(result.filename)
        verificationNotes.push({
          legacyId: result.legacyId,
          filename: result.filename,
          expectedFileHash: null,
          actualFileHash: null,
          parsed: false,
          ok: false,
          problems: ["The previously imported note path is missing from the plan."],
        })
        continue
      }

      let actualFileHash: string | null = null
      const problems: Array<string> = []
      try {
        actualFileHash = sha256File(path)
        if (
          result.actualFileHash !== null &&
          actualFileHash !== result.actualFileHash
        ) {
          problems.push("the existing note changed during the import")
        }
      } catch {
        problems.push("the existing note could not be re-read")
        missing.push(path)
      }
      verificationNotes.push({
        legacyId: result.legacyId,
        filename: result.filename,
        expectedFileHash: result.actualFileHash,
        actualFileHash,
        parsed: true,
        ok: problems.length === 0,
        problems,
      })
    }

    const filenamesAfter = noteFilenames(root)
    const newFilenames = new Set(
      [...filenamesAfter].filter((filename) => !filenamesBefore.has(filename)),
    )
    const expectedFilenames = new Set(imported.map((note) => note.filename))
    for (const filename of expectedFilenames) {
      if (!newFilenames.has(filename)) {
        missing.push(filename)
      }
    }
    const unexpected = [...newFilenames].filter(
      (filename) => !expectedFilenames.has(filename),
    )

    const verification: MigrationVerificationReport = {
      verified: true,
      ok:
        missing.length === 0 &&
        mismatched.length === 0 &&
        unexpected.length === 0 &&
        verificationNotes.every((note) => note.ok),
      expectedNotes: lockedPlan.notes.length,
      writtenNotes: imported.length,
      skippedNotes: noteResults.filter(
        (note) =>
          note.status === "skipped-legacy-id" ||
          note.status === "skipped-conflict",
      ).length,
      parsedNotes: verificationNotes.filter((note) => note.parsed).length,
      missing,
      mismatched,
      unexpected,
      noteCountBefore: filenamesBefore.size,
      noteCountAfter: filenamesAfter.size,
      notes: verificationNotes,
    }

    const sourceAfter = fileFingerprint(options.databasePath)
    const walAfter = fileFingerprint(`${options.databasePath}-wal`)
    const sourceCheckAfter: MigrationSourceCheck = {
      ...sourceCheck,
      after: sourceAfter,
      walAfter,
      unchanged:
        sourceAfter.sha256 === lockedPlan.source.sha256 &&
        sameFingerprint(walAfter, sourceCheck.walBefore),
    }
    context = {
      ...context,
      notes: noteResults,
      verification,
      sourceCheck: sourceCheckAfter,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }

    if (!verification.ok) {
      fail(
        "verification-failed",
        `Verification failed for ${missing.length + mismatched.length + unexpected.length} target(s); see the migration manifest and report.`,
      )
    }

    if (!sourceCheckAfter.unchanged) {
      fail(
        "source-changed",
        "The SQLite source changed during the import. Imported notes were kept; inspect the migration manifest before retrying.",
      )
    }

    if (lockedPlan.issues.some((issue) => issue.severity === "error")) {
      fail(
        "invalid-rows",
        `The source has ${lockedPlan.counts.malformedRows} malformed row(s) and ${lockedPlan.counts.errors} error(s). Valid notes were imported; every invalid row is preserved in the manifest and quarantine.`,
      )
    }

    context = {
      ...context,
      error: null,
      counts: importCounts(lockedPlan, noteResults, warnings, quarantine),
    }
    try {
      writeManifest("imported", null)
    } catch (cause) {
      fail(
        "state-write-failed",
        `The notes were imported and verified, but the final manifest could not be written: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      )
    }

    return buildReport(context, {
      status: "imported",
      ok: true,
      dryRun: false,
      startedAt,
      completedAt: timestampOf(now()),
      root: inspectRoot(root),
    })
  }

  try {
    return Effect.runSync(
      withRepositoryLock(root, Effect.sync(runImport)),
    )
  } catch (cause) {
    if (cause instanceof MigrationImportError) throw cause
    const message =
      cause instanceof MarkdownError
        ? `${cause.code}: ${cause.message}`
        : cause instanceof MigrationSourceError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause)
    const code: MigrationImportErrorCode =
      cause instanceof MigrationSourceError
        ? "source-changed"
        : cause instanceof MarkdownError && cause.code === "repository-locked"
          ? "lock-failed"
          : "state-write-failed"
    const report = failureReport(code, message, inspectRoot(root))
    throw new MigrationImportError(code, message, report, cause)
  }
}

/** Re-exported for callers that want the exact manifest value type. */
export type MigrationManifestIssue = MigrationPlanIssue
export type MigrationPreservedValue = PreservedValue
export type MigrationSqliteValue = SqliteValue
/** Convenience alias mirroring the planner's public row shape. */
export type { PlannedMigrationNote }
