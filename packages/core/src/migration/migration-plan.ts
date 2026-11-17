import { Database } from "bun:sqlite"
import { Markdown } from "@slipmem/schemas/markdown"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  MigrationSourceError,
  withMigrationSourceSnapshot,
} from "./migration-source.js"

export { MigrationSourceError } from "./migration-source.js"
export type { MigrationSourceErrorCode } from "./migration-source.js"

/**
 * Plans the one-way import from the legacy SQLite note tables to Markdown.
 *
 * This module is deliberately read-only. It opens the source database with
 * SQLite's read-only flag, maps every compatible row to a proposed Markdown
 * note, and returns a deterministic plan. It never creates the note root,
 * writes a target note, writes a manifest, or mutates the source database. The
 * forthcoming CLI and importer can print the plan for `--dry-run` and use the
 * same plan as the manifest for a real import.
 */
export const MIGRATION_PLAN_SCHEMA = 1

/** Namespace assigned to legacy rows that predate the optional scope column. */
export const DEFAULT_MIGRATION_SCOPE = "global"

/** Provenance written when the source row has no provenance envelope. */
export const IMPORT_PROVENANCE_SOURCE = "import"

export const NOTE_TABLE_NAMES = [
  "fleeting_note",
  "permanent_note",
  "literature_note",
] as const
export type NoteTableName = (typeof NOTE_TABLE_NAMES)[number]

export type MigrationSourceShape =
  | "empty"
  | "bootstrap"
  | "extended"
  | "mixed"
  | "unrecognized"

export type MigrationTableShape = "bootstrap" | "extended" | "unrecognized"

export type MigrationIssueSeverity = "error" | "warning"

export type MigrationIssueCode =
  | "unsupported-note-table"
  | "missing-required-column"
  | "invalid-id"
  | "blank-title"
  | "blank-content"
  | "blank-reference"
  | "invalid-created-at"
  | "invalid-updated-at"
  | "updated-before-created"
  | "content-too-long"
  | "invalid-scope"
  | "invalid-provenance"
  | "invalid-metadata"

/** A value SQLite can return for one column without losing its identity. */
export type SqliteValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array

/** A JSON-compatible value recovered from a provenance envelope. */
export type PreservedValue =
  | SqliteValue
  | ReadonlyArray<PreservedValue>
  | { readonly [key: string]: PreservedValue }

export interface MigrationSourceTable {
  readonly name: NoteTableName
  /** The row count as reported by SQLite, including malformed rows. */
  readonly rowCount: number
  readonly columns: ReadonlyArray<string>
  readonly shape: MigrationTableShape
}

export interface MigrationSourceInfo {
  readonly path: string
  readonly bytes: number
  /** SHA-256 of the source file before planning; also rechecked after reading. */
  readonly sha256: string
  readonly shape: MigrationSourceShape
  /** Recognized note tables present in the source, in contract order. */
  readonly tables: ReadonlyArray<MigrationSourceTable>
}

export interface MigrationRowSource {
  readonly table: NoteTableName
  /** Zero-based position of the row in the source table read. */
  readonly rowIndex: number
  readonly legacyId: string | null
}

export interface MigrationIssueProblem {
  readonly severity: MigrationIssueSeverity
  readonly code: MigrationIssueCode
  readonly field?: string
  readonly message: string
}

export interface MigrationPlanIssue {
  readonly table: NoteTableName | null
  readonly rowIndex: number | null
  readonly legacyId: string | null
  /** The most severe problem in `problems`. */
  readonly severity: MigrationIssueSeverity
  readonly problems: ReadonlyArray<MigrationIssueProblem>
  /**
   * The complete source row for row-level issues. Text is never truncated or
   * normalized here; it is the fallback for manual review and recovery.
   */
  readonly row: Readonly<Record<string, SqliteValue>> | null
}

/**
 * Metadata that does not fit the frozen Markdown metadata schema.
 *
 * `scope` is the compatibility field from the scoped-memory contract. Unknown
 * provenance envelope keys (such as `externalId`) are kept separately from the
 * known `source` and `actor` fields. Unknown or malformed source columns are
 * retained verbatim so a future importer can decide how to write them into
 * frontmatter.
 */
export interface MigrationNotePreservation {
  readonly scope: string
  readonly provenanceExtras: Readonly<Record<string, PreservedValue>>
  readonly columns: Readonly<Record<string, SqliteValue>>
}

export interface PlannedMigrationNote {
  readonly source: MigrationRowSource
  readonly legacyId: string
  readonly type: Markdown.NoteType
  readonly metadata: Markdown.NoteMetadata
  readonly preservation: MigrationNotePreservation
  /** The Markdown body, byte-for-byte from `content`. */
  readonly body: string
  readonly filename: string
  /** Proposed path under the configured note root. Never written by planning. */
  readonly targetPath: string
  /** SHA-256 of the complete source row, for source-to-target verification. */
  readonly sourceRowHash: string
  /** SHA-256 of the canonical metadata, preservation data, and body. */
  readonly contentHash: string
}

export interface MigrationFilenameCollision {
  readonly source: MigrationRowSource
  readonly baseFilename: string
  readonly filename: string
}

export interface MigrationPlanCounts {
  readonly sourceRows: number
  readonly plannedNotes: number
  readonly malformedRows: number
  readonly issues: number
  readonly errors: number
  readonly warnings: number
  readonly collisions: number
  readonly sourceByType: Readonly<Record<Markdown.NoteType, number>>
  readonly plannedByType: Readonly<Record<Markdown.NoteType, number>>
  readonly malformedByType: Readonly<Record<Markdown.NoteType, number>>
}

export interface MigrationPlan {
  readonly schema: typeof MIGRATION_PLAN_SCHEMA
  readonly source: MigrationSourceInfo
  readonly notes: ReadonlyArray<PlannedMigrationNote>
  readonly issues: ReadonlyArray<MigrationPlanIssue>
  readonly collisions: ReadonlyArray<MigrationFilenameCollision>
  readonly counts: MigrationPlanCounts
  /** Stable hash of the plan, suitable for a manifest and rerun comparison. */
  readonly hash: string
}

export interface MigrationPlanOptions {
  /** Path to the SQLite database. It is opened read-only. */
  readonly databasePath: string
  /** Note root used only to compute target paths. Defaults to `.slipmem`. */
  readonly noteRoot?: string
  /**
   * Existing note filenames, used to avoid proposing a colliding target.
   * Values are filenames, not absolute paths.
   */
  readonly takenFilenames?: Iterable<string>
}

interface NoteTableDefinition {
  readonly name: NoteTableName
  readonly type: Markdown.NoteType
  readonly requiredColumns: ReadonlyArray<string>
}

const baseColumns = ["id", "title", "content", "created_at", "updated_at"] as const
const knownOptionalColumns = ["scope", "provenance"] as const

const NOTE_TABLES: ReadonlyArray<NoteTableDefinition> = [
  {
    name: "fleeting_note",
    type: "fleeting",
    requiredColumns: baseColumns,
  },
  {
    name: "permanent_note",
    type: "permanent",
    requiredColumns: baseColumns,
  },
  {
    name: "literature_note",
    type: "literature",
    requiredColumns: [...baseColumns, "reference"],
  },
]

interface RawRow {
  readonly definition: NoteTableDefinition
  readonly columns: ReadonlyArray<string>
  readonly rowIndex: number
  readonly row: Readonly<Record<string, SqliteValue>>
}

interface Candidate {
  readonly source: MigrationRowSource
  readonly legacyId: string
  readonly definition: NoteTableDefinition
  readonly row: Readonly<Record<string, SqliteValue>>
  readonly title: string
  readonly body: string
  readonly reference: string | null
  readonly createdAt: number
  readonly created: Markdown.UtcTimestamp
  readonly updated: Markdown.UtcTimestamp
  readonly provenance: Markdown.Provenance
  readonly preservation: MigrationNotePreservation
  readonly sourceRowHash: string
}

const typeCounts = (): Record<Markdown.NoteType, number> => ({
  fleeting: 0,
  permanent: 0,
  literature: 0,
})

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const normalizeSqliteValue = (value: unknown): SqliteValue => {
  if (value === null) return null
  if (typeof value === "string") return value
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value
  if (value instanceof Uint8Array) return value
  return String(value)
}

const normalizeRow = (
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SqliteValue>> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)]),
  )

/**
 * Stable JSON used for manifests and hashes. Object keys are sorted, and
 * SQLite-only values get explicit tags so a plan cannot change meaning when it
 * is serialized.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null) return "null"

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
    case "bigint":
      return `{"$bigint":${JSON.stringify(value.toString())}}`
    case "undefined":
      return "null"
    case "object": {
      if (value instanceof Uint8Array) {
        return `{"$base64":${JSON.stringify(Buffer.from(value).toString("base64"))}}`
      }
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`
      }
      const object = value as Readonly<Record<string, unknown>>
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(",")}}`
    }
    default:
      return JSON.stringify(String(value))
  }
}

const problem = (
  severity: MigrationIssueSeverity,
  code: MigrationIssueCode,
  message: string,
  field?: string,
): MigrationIssueProblem =>
  field === undefined ? { severity, code, message } : { severity, code, message, field }

const issueSeverity = (
  problems: ReadonlyArray<MigrationIssueProblem>,
): MigrationIssueSeverity =>
  problems.some((entry) => entry.severity === "error") ? "error" : "warning"

const hasErrors = (problems: ReadonlyArray<MigrationIssueProblem>): boolean =>
  problems.some((entry) => entry.severity === "error")

const tableShape = (
  definition: NoteTableDefinition,
  columns: ReadonlyArray<string>,
): MigrationTableShape => {
  if (definition.requiredColumns.some((column) => !columns.includes(column))) {
    return "unrecognized"
  }

  return columns.some((column) => !definition.requiredColumns.includes(column))
    ? "extended"
    : "bootstrap"
}

const sourceShape = (
  tables: ReadonlyArray<MigrationSourceTable>,
): MigrationSourceShape => {
  if (tables.length === 0) return "empty"
  if (tables.some((table) => table.shape === "unrecognized")) return "unrecognized"

  const shapes = new Set(tables.map((table) => table.shape))
  if (shapes.size > 1) return "mixed"
  return shapes.has("extended") ? "extended" : "bootstrap"
}

/**
 * Reads an epoch-millisecond value without losing integer identity.
 *
 * The source connection uses `safeIntegers`, so SQLite INTEGER values arrive as
 * bigints. A valid JavaScript Date is always within the safe-integer range; a
 * larger bigint is out of range and is reported as an invalid timestamp rather
 * than rounded.
 */
const timestampMillis = (value: SqliteValue): number | null => {
  let millis: number
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return null
    }
    millis = Number(value)
  } else if (typeof value === "number" && Number.isFinite(value)) {
    millis = value
  } else {
    return null
  }

  try {
    Markdown.toUtcTimestamp(millis)
    return millis
  } catch {
    return null
  }
}

const readProvenance = (
  value: SqliteValue,
): {
  readonly provenance: Markdown.Provenance
  readonly extras: Readonly<Record<string, PreservedValue>>
  readonly problems: ReadonlyArray<MigrationIssueProblem>
  /** Whether the raw column must be retained because it is not represented. */
  readonly preserveRaw: boolean
} => {
  const fallback: Markdown.Provenance = { source: IMPORT_PROVENANCE_SOURCE }

  if (value === null) {
    return {
      provenance: fallback,
      extras: {},
      problems: [
        problem(
          "warning",
          "invalid-provenance",
          "The provenance column is null; the note will be imported with import provenance.",
          "provenance",
        ),
      ],
      preserveRaw: true,
    }
  }

  if (typeof value !== "string") {
    return {
      provenance: fallback,
      extras: {},
      problems: [
        problem(
          "warning",
          "invalid-provenance",
          "The provenance column is not text; the raw value is preserved and the note will be imported with import provenance.",
          "provenance",
        ),
      ],
      preserveRaw: true,
    }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return {
      provenance: fallback,
      extras: {},
      problems: [
        problem(
          "warning",
          "invalid-provenance",
          "The provenance column is not valid JSON; the raw value is preserved and the note will be imported with import provenance.",
          "provenance",
        ),
      ],
      preserveRaw: true,
    }
  }

  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {
      provenance: fallback,
      extras: {},
      problems: [
        problem(
          "warning",
          "invalid-provenance",
          "The provenance envelope is not a JSON object; the raw value is preserved and the note will be imported with import provenance.",
          "provenance",
        ),
      ],
      preserveRaw: true,
    }
  }

  const envelope = decoded as Readonly<Record<string, PreservedValue>>
  const source = envelope["source"]
  if (typeof source !== "string" || source.trim().length === 0) {
    return {
      provenance: fallback,
      extras: envelope,
      problems: [
        problem(
          "warning",
          "invalid-provenance",
          "The provenance envelope has no usable source; the raw value is preserved and the note will be imported with import provenance.",
          "provenance",
        ),
      ],
      preserveRaw: true,
    }
  }

  const extras: Record<string, PreservedValue> = {}
  const problems: Array<MigrationIssueProblem> = []

  for (const [key, entry] of Object.entries(envelope)) {
    if (key === "source") continue
    if (key === "actor" && typeof entry === "string") continue
    extras[key] = entry
  }

  if (envelope["actor"] !== undefined && typeof envelope["actor"] !== "string") {
    problems.push(
      problem(
        "warning",
        "invalid-provenance",
        "The provenance actor is not text; it is preserved separately and omitted from known metadata.",
        "provenance.actor",
      ),
    )
  }

  return {
    provenance:
      typeof envelope["actor"] === "string"
        ? { source, actor: envelope["actor"] }
        : { source },
    extras,
    problems,
    preserveRaw: false,
  }
}

const readPreservation = (
  row: Readonly<Record<string, SqliteValue>>,
  definition: NoteTableDefinition,
  columns: ReadonlyArray<string>,
): {
  readonly scope: string
  readonly provenance: Markdown.Provenance
  readonly preservation: MigrationNotePreservation
  readonly problems: ReadonlyArray<MigrationIssueProblem>
} => {
  const problems: Array<MigrationIssueProblem> = []
  const preservedColumns: Record<string, SqliteValue> = {}

  const knownColumns = new Set<string>([
    ...definition.requiredColumns,
    ...knownOptionalColumns,
  ])
  for (const column of columns) {
    if (!knownColumns.has(column)) {
      preservedColumns[column] = row[column] ?? null
    }
  }

  let scope = DEFAULT_MIGRATION_SCOPE
  if (columns.includes("scope")) {
    const value = row["scope"]
    if (typeof value === "string" && value.trim().length > 0) {
      scope = value
    } else {
      preservedColumns["scope"] = value ?? null
      problems.push(
        problem(
          "warning",
          "invalid-scope",
          `The source scope is not a non-empty string; the note will be imported into "${DEFAULT_MIGRATION_SCOPE}" and the raw value is preserved.`,
          "scope",
        ),
      )
    }
  }

  let provenance: Markdown.Provenance = { source: IMPORT_PROVENANCE_SOURCE }
  let provenanceExtras: Readonly<Record<string, PreservedValue>> = {}
  if (columns.includes("provenance")) {
    const raw = row["provenance"] ?? null
    const parsed = readProvenance(raw)
    provenance = parsed.provenance
    provenanceExtras = parsed.extras
    problems.push(...parsed.problems)

    // Keep the raw column only when it could not be represented as a known
    // provenance envelope, so a future writer can decide how to recover it.
    if (parsed.preserveRaw) {
      preservedColumns["provenance"] = raw
    }
  }

  return {
    scope,
    provenance,
    preservation: {
      scope,
      provenanceExtras,
      columns: preservedColumns,
    },
    problems,
  }
}

const legacyIdFrom = (
  row: Readonly<Record<string, SqliteValue>>,
): string | null => {
  const value = row["id"]
  return typeof value === "string" && value.length > 0 ? value : null
}

const rowProblemSource = (
  definition: NoteTableDefinition,
  rowIndex: number,
  legacyId: string | null,
): MigrationRowSource => ({
  table: definition.name,
  rowIndex,
  legacyId,
})

const planRow = (
  raw: RawRow,
  problems: Array<MigrationIssueProblem>,
): Candidate | null => {
  const { columns, definition, row, rowIndex } = raw
  const legacyId = legacyIdFrom(row)

  if (legacyId === null) {
    problems.push(
      problem(
        "error",
        "invalid-id",
        "The source row has no non-empty text id; the row is reported and not imported.",
        "id",
      ),
    )
  }

  const titleValue = row["title"]
  const title = typeof titleValue === "string" ? titleValue : ""
  if (typeof titleValue !== "string" || title.trim().length === 0) {
    problems.push(
      problem(
        "error",
        "blank-title",
        "The source row has no non-whitespace text title; the row is reported and not imported.",
        "title",
      ),
    )
  }

  const bodyValue = row["content"]
  const body = typeof bodyValue === "string" ? bodyValue : ""
  if (typeof bodyValue !== "string" || bodyValue.trim().length === 0) {
    problems.push(
      problem(
        "error",
        "blank-content",
        "The source row has no non-whitespace text content; the row is reported and not imported.",
        "content",
      ),
    )
  } else if (bodyValue.length > Markdown.CONTENT_LIMITS[definition.type]) {
    problems.push(
      problem(
        "error",
        "content-too-long",
        `The source content is ${bodyValue.length} characters; ${definition.type} notes allow at most ${Markdown.CONTENT_LIMITS[definition.type]}. The complete text is preserved in the issue row.`,
        "content",
      ),
    )
  }

  let reference: string | null = null
  if (definition.type === "literature") {
    const referenceValue = row["reference"]
    reference = typeof referenceValue === "string" ? referenceValue : null
    if (reference === null || reference.trim().length === 0) {
      problems.push(
        problem(
          "error",
          "blank-reference",
          "A literature source row needs a non-whitespace text reference; the row is reported and not imported.",
          "reference",
        ),
      )
    }
  }

  const createdRaw = row["created_at"]
  const createdMillis = timestampMillis(createdRaw ?? null)
  const created =
    createdMillis === null ? null : Markdown.toUtcTimestamp(createdMillis)
  if (created === null) {
    problems.push(
      problem(
        "error",
        "invalid-created-at",
        "created_at must be a finite epoch-millisecond value inside the JavaScript Date range.",
        "created_at",
      ),
    )
  }

  const updatedRaw = row["updated_at"]
  const updatedMillis = timestampMillis(updatedRaw ?? null)
  const updated =
    updatedMillis === null ? null : Markdown.toUtcTimestamp(updatedMillis)
  if (updated === null) {
    problems.push(
      problem(
        "error",
        "invalid-updated-at",
        "updated_at must be a finite epoch-millisecond value inside the JavaScript Date range.",
        "updated_at",
      ),
    )
  }

  if (
    createdMillis !== null &&
    updatedMillis !== null &&
    updatedMillis < createdMillis
  ) {
    problems.push(
      problem(
        "error",
        "updated-before-created",
        "updated_at is earlier than created_at; the row is reported and not imported.",
        "updated_at",
      ),
    )
  }

  const preservation = readPreservation(row, definition, columns)
  problems.push(...preservation.problems)

  if (
    hasErrors(problems) ||
    legacyId === null ||
    created === null ||
    updated === null
  ) {
    return null
  }

  return {
    source: rowProblemSource(definition, rowIndex, legacyId),
    legacyId,
    definition,
    row,
    title,
    body,
    reference,
    createdAt: createdMillis as number,
    created,
    updated,
    provenance: preservation.provenance,
    preservation: preservation.preservation,
    sourceRowHash: sha256(canonicalJson(row)),
  }
}

/**
 * Reads and maps the legacy database into a deterministic, non-writing plan.
 *
 * Missing note tables (including an empty database) produce zero notes rather
 * than an error. A table with an incompatible shape is reported as an issue and
 * skipped. A malformed row is reported with its complete original row and is
 * not truncated, repaired, or imported.
 */
export const planMigration = (options: MigrationPlanOptions): MigrationPlan => {
  const databasePath = options.databasePath
  const noteRoot = options.noteRoot ?? ".slipmem"
  const taken = new Set<string>(options.takenFilenames ?? [])
  const tables: Array<MigrationSourceTable> = []
  const rows: Array<RawRow> = []
  /** Rows from tables whose shape cannot be imported, kept for quarantine. */
  const unrecognizedRows: Array<{
    readonly definition: NoteTableDefinition
    readonly row: Readonly<Record<string, SqliteValue>>
  }> = []
  const issues: Array<MigrationPlanIssue> = []

  // Read from a private copy. Opening the original read-only would still create
  // a `-shm` beside a WAL source (or fail on a read-only directory), which a
  // planner and a dry run must never do.
  const sourceSnapshot = withMigrationSourceSnapshot(databasePath, (snapshot) => {
    try {
      const database = new Database(snapshot.databasePath, {
        readonly: true,
        safeIntegers: true,
      })
      try {
        // Belt and braces: the staged copy is disposable, but planning must
        // still never write note data into it.
        database.exec("PRAGMA query_only = ON")

        for (const definition of NOTE_TABLES) {
          const object = database
            .query<{ readonly type: string }, [string]>(
              "SELECT type FROM sqlite_master WHERE name = ?",
            )
            .get(definition.name)

          if (object === null) {
            continue
          }

          if (object.type !== "table") {
            issues.push({
              table: definition.name,
              rowIndex: null,
              legacyId: null,
              severity: "error",
              problems: [
                problem(
                  "error",
                  "unsupported-note-table",
                  `"${definition.name}" is a ${object.type}, not a table; it is ignored.`,
                ),
              ],
              row: null,
            })
            continue
          }

          const columns = database
            .query<{ readonly name: string }, []>(
              `PRAGMA table_info("${definition.name}")`,
            )
            .all()
            .map((column) => column.name)
          const shape = tableShape(definition, columns)

          if (shape === "unrecognized") {
            const missing = definition.requiredColumns.filter(
              (column) => !columns.includes(column),
            )
            const tableRows = database
              .query<Readonly<Record<string, unknown>>, []>(
                `SELECT * FROM "${definition.name}"`,
              )
              .all()
              .map(normalizeRow)
            tables.push({
              name: definition.name,
              rowCount: tableRows.length,
              columns,
              shape,
            })
            issues.push({
              table: definition.name,
              rowIndex: null,
              legacyId: null,
              severity: "error",
              problems: [
                problem(
                  "error",
                  "missing-required-column",
                  `"${definition.name}" is missing required column(s): ${missing.join(", ")}. The table's rows are not imported; every row is preserved in the issue report and quarantine for manual review.`,
                ),
              ],
              row: null,
            })
            for (const [rowIndex, row] of tableRows.entries()) {
              unrecognizedRows.push({ definition, row })
              issues.push({
                table: definition.name,
                rowIndex,
                legacyId: legacyIdFrom(row),
                severity: "error",
                problems: [
                  problem(
                    "error",
                    "missing-required-column",
                    `Row ${rowIndex} of "${definition.name}" cannot be mapped because the table is missing required column(s): ${missing.join(", ")}. The complete raw row is preserved for manual review and recovery.`,
                  ),
                ],
                row,
              })
            }
            continue
          }

          const tableRows = database
            .query<Readonly<Record<string, unknown>>, []>(
              `SELECT * FROM "${definition.name}"`,
            )
            .all()
            .map(normalizeRow)

          tables.push({
            name: definition.name,
            rowCount: tableRows.length,
            columns,
            shape,
          })

          for (const [rowIndex, row] of tableRows.entries()) {
            rows.push({ definition, columns, rowIndex, row })
          }
        }
      } finally {
        database.close()
      }
    } catch (cause) {
      if (cause instanceof MigrationSourceError) throw cause
      throw new MigrationSourceError(
        "unreadable",
        `The migration source "${databasePath}" could not be read as a SQLite database.`,
        cause,
      )
    }

    return { main: snapshot.main }
  })

  const hashBefore = sourceSnapshot.main.sha256 ?? ""

  const candidates: Array<Candidate> = []
  for (const raw of rows) {
    const problems: Array<MigrationIssueProblem> = []
    const candidate = planRow(raw, problems)

    if (problems.length > 0) {
      issues.push({
        table: raw.definition.name,
        rowIndex: raw.rowIndex,
        legacyId: legacyIdFrom(raw.row),
        severity: issueSeverity(problems),
        problems,
        row: raw.row,
      })
    }

    if (candidate !== null) {
      candidates.push(candidate)
    }
  }

  candidates.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    const leftTable = NOTE_TABLE_NAMES.indexOf(left.definition.name)
    const rightTable = NOTE_TABLE_NAMES.indexOf(right.definition.name)
    if (leftTable !== rightTable) return leftTable - rightTable
    const leftId = left.source.legacyId ?? ""
    const rightId = right.source.legacyId ?? ""
    if (leftId !== rightId) return leftId < rightId ? -1 : 1
    return left.source.rowIndex - right.source.rowIndex
  })

  const notes: Array<PlannedMigrationNote> = []
  const collisions: Array<MigrationFilenameCollision> = []

  for (const candidate of candidates) {
    const baseFilename = `${candidate.created.filenamePrefix}-${Markdown.slugifyTitle(candidate.title)}.md`
    const filename = Markdown.noteFilename({
      title: candidate.title,
      createdAt: candidate.createdAt,
      taken,
    })
    const metadata: Markdown.NoteMetadata = {
      schema: Markdown.SCHEMA_VERSION,
      id: filename.slice(0, -".md".length),
      type: candidate.definition.type,
      title: candidate.title,
      createdAt: candidate.created.isoTimestamp,
      updatedAt: candidate.updated.isoTimestamp,
      legacyId: candidate.legacyId,
      provenance: candidate.provenance,
      ...(candidate.reference === null
        ? {}
        : { reference: candidate.reference }),
    }

    const decoded = Schema.decodeUnknownOption(Markdown.NoteMetadata)(metadata)
    if (decoded._tag === "None") {
      issues.push({
        table: candidate.definition.name,
        rowIndex: candidate.source.rowIndex,
        legacyId: candidate.source.legacyId,
        severity: "error",
        problems: [
          problem(
            "error",
            "invalid-metadata",
            "The mapped note metadata does not satisfy the frozen Markdown schema; the complete source row is preserved for review.",
          ),
        ],
        row: candidate.row,
      })
      continue
    }

    taken.add(filename)
    if (filename !== baseFilename) {
      collisions.push({
        source: candidate.source,
        baseFilename,
        filename,
      })
    }

    const contentHash = sha256(
      canonicalJson({
        schema: MIGRATION_PLAN_SCHEMA,
        metadata,
        preservation: candidate.preservation,
        body: candidate.body,
      }),
    )

    notes.push({
      source: candidate.source,
      legacyId: candidate.legacyId,
      type: candidate.definition.type,
      metadata,
      preservation: candidate.preservation,
      body: candidate.body,
      filename,
      targetPath: join(noteRoot, filename),
      sourceRowHash: candidate.sourceRowHash,
      contentHash,
    })
  }

  const sourceByType = typeCounts()
  for (const row of rows) {
    sourceByType[row.definition.type] += 1
  }
  for (const row of unrecognizedRows) {
    sourceByType[row.definition.type] += 1
  }

  const plannedByType = typeCounts()
  for (const note of notes) {
    plannedByType[note.type] += 1
  }

  const malformedByType = typeCounts()
  const malformedRows = new Set<string>()
  for (const issue of issues) {
    if (issue.severity !== "error" || issue.table === null || issue.rowIndex === null) {
      continue
    }
    const definition = NOTE_TABLES.find((table) => table.name === issue.table)
    if (definition === undefined) continue
    malformedByType[definition.type] += 1
    malformedRows.add(`${issue.table}:${issue.rowIndex}`)
  }

  const errors = issues.reduce(
    (total, issue) =>
      total + issue.problems.filter((entry) => entry.severity === "error").length,
    0,
  )
  const warnings = issues.reduce(
    (total, issue) =>
      total + issue.problems.filter((entry) => entry.severity === "warning").length,
    0,
  )

  const source: MigrationSourceInfo = {
    path: databasePath,
    bytes: sourceSnapshot.main.bytes,
    sha256: hashBefore,
    shape: sourceShape(tables),
    tables,
  }

  const counts: MigrationPlanCounts = {
    sourceRows: rows.length + unrecognizedRows.length,
    plannedNotes: notes.length,
    malformedRows: malformedRows.size,
    issues: issues.length,
    errors,
    warnings,
    collisions: collisions.length,
    sourceByType,
    plannedByType,
    malformedByType,
  }

  const hash = sha256(
    canonicalJson({
      schema: MIGRATION_PLAN_SCHEMA,
      source,
      notes: notes.map((note) => ({
        source: note.source,
        legacyId: note.legacyId,
        filename: note.filename,
        targetPath: note.targetPath,
        sourceRowHash: note.sourceRowHash,
        contentHash: note.contentHash,
      })),
      issues,
      collisions,
    }),
  )

  return {
    schema: MIGRATION_PLAN_SCHEMA,
    source,
    notes,
    issues,
    collisions,
    counts,
    hash,
  }
}
