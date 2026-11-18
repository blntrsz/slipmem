import { Database } from "bun:sqlite"
import { Markdown } from "@slipmem/schemas/markdown"
import {
  inspectLegacyRow,
  legacyNoteTableDefinition,
  type LegacyRowMapping,
  type MigrationIssueProblem,
  type NoteTableName,
  type SqliteValue,
} from "./migration-plan.js"
import { MigrationSourceError, withMigrationSourceSnapshot } from "./migration-source.js"

/**
 * Explicit, read-only access to the retired SQLite note database.
 *
 * This is the one-release compatibility path required by the cutover plan. It
 * is opt-in, is never called by startup, and is not a second source of truth:
 * Markdown under `.slipmem/` remains authoritative. The reader copies the
 * source database and its `-wal`/`-journal` sidecars into a private temporary
 * directory, opens only the copy with SQLite's read-only and `query_only`
 * guards, and never returns a handle that can write.
 *
 * `listLegacyNotes` and `getLegacyNote` are bounded. They expose both the
 * normalized raw row and the mapped legacy fields for valid rows, with the
 * same validation and warnings as the migration planner. Invalid rows are
 * returned with `note: null`, their raw values intact, and the planner's
 * problems instead of being skipped, truncated, or repaired.
 */

export const LEGACY_READ_SCHEMA = 1

/** Marks reports produced by the compatibility reader. */
export const LEGACY_READ_COMPATIBILITY = "one-release-read-only"

export const LEGACY_READ_DEFAULT_LIMIT = 25
export const LEGACY_READ_MAX_LIMIT = 100
export const LEGACY_READ_MAX_OFFSET = 100_000
export const LEGACY_READ_MAX_ID_LENGTH = 512

const NOTE_TYPES: ReadonlyArray<Markdown.NoteType> = [
  "fleeting",
  "permanent",
  "literature",
]

const isNoteType = (value: unknown): value is Markdown.NoteType =>
  value === "fleeting" || value === "permanent" || value === "literature"

export interface LegacyReadSource {
  readonly path: string
  readonly bytes: number
  /** SHA-256 of the source main database before and after the read. */
  readonly sha256: string
}

/** A table-level fact that does not belong to one row. */
export interface LegacyReadWarning {
  readonly code:
    | "read-only-one-release"
    | "unsupported-note-table"
    | "missing-required-column"
    | "missing-note-table"
  readonly message: string
  readonly type?: Markdown.NoteType
  readonly table?: NoteTableName
}

export interface LegacyReadRow {
  readonly type: Markdown.NoteType
  readonly table: NoteTableName
  /**
   * Zero-based position within its source table read (`offset + index`). For
   * `get` it is always 0 because no table order is scanned.
   */
  readonly rowIndex: number
  readonly legacyId: string | null
  /** The normalized raw row. Text is never truncated or rewritten. */
  readonly raw: Readonly<Record<string, SqliteValue>>
  /** Mapped fields for a valid migration candidate; null for an invalid row. */
  readonly note: LegacyRowMapping | null
  readonly valid: boolean
  /** Planner warnings/errors for this row, including invalid metadata. */
  readonly problems: ReadonlyArray<MigrationIssueProblem>
}

export interface LegacyListOptions {
  readonly databasePath: string
  /** Restrict the read to one legacy note table. Defaults to all three. */
  readonly type?: Markdown.NoteType
  /** Page size. Defaults to 25; must be an integer from 1 to 100. */
  readonly limit?: number
  /** Rows to skip in contract table order (fleeting, permanent, literature). */
  readonly offset?: number
}

export interface LegacyGetOptions {
  readonly databasePath: string
  readonly type: Markdown.NoteType
  /** The source `id` column. Legacy IDs may be shared across note types. */
  readonly legacyId: string
}

export interface LegacyListReport {
  readonly schema: typeof LEGACY_READ_SCHEMA
  readonly compatibility: typeof LEGACY_READ_COMPATIBILITY
  readonly readOnly: true
  readonly source: LegacyReadSource
  readonly type: Markdown.NoteType | null
  readonly offset: number
  readonly limit: number
  /** Total rows in the selected table(s), before paging. */
  readonly total: number
  readonly rows: ReadonlyArray<LegacyReadRow>
  readonly warnings: ReadonlyArray<LegacyReadWarning>
}

export interface LegacyGetReport {
  readonly schema: typeof LEGACY_READ_SCHEMA
  readonly compatibility: typeof LEGACY_READ_COMPATIBILITY
  readonly readOnly: true
  readonly source: LegacyReadSource
  readonly type: Markdown.NoteType
  readonly legacyId: string
  readonly row: LegacyReadRow | null
  readonly warnings: ReadonlyArray<LegacyReadWarning>
}

interface TableState {
  readonly definition: ReturnType<typeof legacyNoteTableDefinition>
  readonly present: boolean
  readonly table: boolean
  readonly columns: ReadonlyArray<string>
  readonly missingColumns: ReadonlyArray<string>
  readonly rowCount: number
}

const compatibilityWarning = (): LegacyReadWarning => ({
  code: "read-only-one-release",
  message:
    "Read-only one-release compatibility view of the retired SQLite database. Markdown under .slipmem/ is the source of truth; this reader never writes, imports, repairs, or deletes rows.",
})

const limitOf = (value: number | undefined): number => {
  const limit = value ?? LEGACY_READ_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > LEGACY_READ_MAX_LIMIT) {
    throw new RangeError(
      `limit must be an integer from 1 to ${LEGACY_READ_MAX_LIMIT}; received ${String(limit)}.`,
    )
  }
  return limit
}

const offsetOf = (value: number | undefined): number => {
  const offset = value ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > LEGACY_READ_MAX_OFFSET) {
    throw new RangeError(
      `offset must be an integer from 0 to ${LEGACY_READ_MAX_OFFSET}; received ${String(offset)}.`,
    )
  }
  return offset
}

const typeOf = (value: unknown): Markdown.NoteType => {
  if (!isNoteType(value)) {
    throw new RangeError(
      `type must be one of ${NOTE_TYPES.join(", ")}; received ${String(value)}.`,
    )
  }
  return value
}

const tableObject = (
  database: Database,
  name: NoteTableName,
): { readonly type: string } | null =>
  database
    .query<{ readonly type: string }, [string]>(
      "SELECT type FROM sqlite_master WHERE name = ?",
    )
    .get(name)

const tableColumns = (
  database: Database,
  name: NoteTableName,
): ReadonlyArray<string> =>
  database
    .query<{ readonly name: string }, []>(`PRAGMA table_info("${name}")`)
    .all()
    .map((column) => column.name)

const tableRowCount = (database: Database, name: NoteTableName): number => {
  const count = database
    .query<{ readonly count: unknown }, []>(
      `SELECT COUNT(*) AS count FROM "${name}"`,
    )
    .get()?.count
  if (typeof count === "bigint") return Number(count)
  if (typeof count === "number" && Number.isFinite(count)) return count
  return 0
}

const inspectTable = (
  database: Database,
  type: Markdown.NoteType,
): TableState => {
  const definition = legacyNoteTableDefinition(type)
  const object = tableObject(database, definition.name)
  if (object === null) {
    return {
      definition,
      present: false,
      table: false,
      columns: [],
      missingColumns: [],
      rowCount: 0,
    }
  }
  if (object.type !== "table") {
    return {
      definition,
      present: true,
      table: false,
      columns: [],
      missingColumns: [],
      rowCount: 0,
    }
  }

  const columns = tableColumns(database, definition.name)
  return {
    definition,
    present: true,
    table: true,
    columns,
    missingColumns: definition.requiredColumns.filter(
      (column) => !columns.includes(column),
    ),
    rowCount: tableRowCount(database, definition.name),
  }
}

const tableWarnings = (
  state: TableState,
  { missingTable }: { readonly missingTable: "warn" | "silent" },
): ReadonlyArray<LegacyReadWarning> => {
  const { definition } = state
  if (!state.present) {
    return missingTable === "warn"
      ? [
          {
            code: "missing-note-table",
            message: `The legacy database has no "${definition.name}" table, so it contributes no rows.`,
            type: definition.type,
            table: definition.name,
          },
        ]
      : []
  }
  if (!state.table) {
    return [
      {
        code: "unsupported-note-table",
        message: `"${definition.name}" is not a table; it is ignored and no row is exposed as a note.`,
        type: definition.type,
        table: definition.name,
      },
    ]
  }
  if (state.missingColumns.length > 0) {
    return [
      {
        code: "missing-required-column",
        message: `"${definition.name}" is missing required column(s): ${state.missingColumns.join(
          ", ",
        )}. Rows are still shown raw with note: null for manual review.`,
        type: definition.type,
        table: definition.name,
      },
    ]
  }
  return []
}

const readRow = (
  database: Database,
  state: TableState,
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
): LegacyReadRow => {
  const inspection = inspectLegacyRow({
    table: state.definition.name,
    columns: state.columns,
    rowIndex,
    row,
  })
  const rawId = inspection.raw["id"]
  return {
    type: state.definition.type,
    table: state.definition.name,
    rowIndex,
    legacyId:
      typeof rawId === "string" && rawId.length > 0 ? rawId : null,
    raw: inspection.raw,
    note: inspection.mapping,
    valid: inspection.mapping !== null,
    problems: inspection.problems,
  }
}

const pageRows = (
  database: Database,
  state: TableState,
  limit: number,
  offset: number,
): ReadonlyArray<LegacyReadRow> => {
  if (limit === 0) return []

  // A valid legacy table always has a unique text id. Ordering by it keeps
  // pages stable even though the archive is no longer written. A malformed
  // table may lack id, so it is read without an order and every row is
  // returned as invalid.
  const order = state.missingColumns.length === 0 ? ` ORDER BY "id"` : ""
  const rows = database
    .query<Readonly<Record<string, unknown>>, [number, number]>(
      `SELECT * FROM "${state.definition.name}"${order} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset)

  return rows.map((row, index) =>
    readRow(database, state, offset + index, row),
  )
}

const withReadOnlyDatabase = <A>(
  databasePath: string,
  use: (
    database: Database,
    source: LegacyReadSource,
  ) => A,
): A =>
  withMigrationSourceSnapshot(databasePath, (snapshot) => {
    const source: LegacyReadSource = {
      path: databasePath,
      bytes: snapshot.main.bytes,
      sha256: snapshot.main.sha256 ?? "",
    }
    let database: Database
    try {
      database = new Database(snapshot.databasePath, {
        readonly: true,
        safeIntegers: true,
      })
    } catch (cause) {
      throw new MigrationSourceError(
        "unreadable",
        `The migration source "${databasePath}" could not be opened as a SQLite database.`,
        cause,
      )
    }

    try {
      // The copy is disposable, but compatibility reads must still never be
      // able to write note data into it.
      database.exec("PRAGMA query_only = ON")
      return use(database, source)
    } catch (cause) {
      if (cause instanceof MigrationSourceError) throw cause
      throw new MigrationSourceError(
        "unreadable",
        `The migration source "${databasePath}" could not be read as a SQLite database.`,
        cause,
      )
    } finally {
      database.close()
    }
  })

/**
 * Lists a bounded page of legacy rows.
 *
 * The source is copied and read without any write. With no `type`, paging walks
 * the frozen contract order (fleeting, permanent, literature). A legacy ID is
 * only unique inside its own table, so rows keep their `type` even when the
 * same ID appears in more than one table.
 */
export const listLegacyNotes = (
  options: LegacyListOptions,
): LegacyListReport => {
  const limit = limitOf(options.limit)
  const offset = offsetOf(options.offset)
  const type =
    options.type === undefined ? null : typeOf(options.type)

  return withReadOnlyDatabase(options.databasePath, (database, source) => {
    const types = type === null ? NOTE_TYPES : [type]
    const warnings: Array<LegacyReadWarning> = [compatibilityWarning()]
    const rows: Array<LegacyReadRow> = []
    let total = 0
    let skip = offset
    let remaining = limit

    for (const candidateType of types) {
      const state = inspectTable(database, candidateType)
      warnings.push(...tableWarnings(state, { missingTable: "silent" }))
      total += state.rowCount

      const skipHere = Math.max(0, skip)
      skip = Math.max(0, skip - state.rowCount)
      if (remaining === 0 || skipHere >= state.rowCount) continue

      const take = Math.min(remaining, state.rowCount - skipHere)
      rows.push(...pageRows(database, state, take, skipHere))
      remaining -= take
    }

    return {
      schema: LEGACY_READ_SCHEMA,
      compatibility: LEGACY_READ_COMPATIBILITY,
      readOnly: true,
      source,
      type,
      offset,
      limit,
      total,
      rows,
      warnings,
    }
  })
}

/**
 * Reads one legacy row by note type and source ID.
 *
 * Type is required because legacy IDs are only unique per table. The row is
 * returned raw, plus mapped fields when it is valid. A missing table or row
 * yields `row: null`; a malformed table yields the row raw with warnings.
 */
export const getLegacyNote = (options: LegacyGetOptions): LegacyGetReport => {
  const type = typeOf(options.type)
  if (
    typeof options.legacyId !== "string" ||
    options.legacyId.length === 0 ||
    options.legacyId.length > LEGACY_READ_MAX_ID_LENGTH
  ) {
    throw new RangeError(
      `legacyId must be a non-empty string of at most ${LEGACY_READ_MAX_ID_LENGTH} characters.`,
    )
  }

  return withReadOnlyDatabase(options.databasePath, (database, source) => {
    const state = inspectTable(database, type)
    const warnings: Array<LegacyReadWarning> = [
      compatibilityWarning(),
      ...tableWarnings(state, { missingTable: "warn" }),
    ]

    let row: LegacyReadRow | null = null
    if (state.table && state.columns.includes("id")) {
      const found = database
        .query<Readonly<Record<string, unknown>>, [string]>(
          `SELECT * FROM "${state.definition.name}" WHERE "id" = ?`,
        )
        .get(options.legacyId)
      if (found !== null) {
        row = readRow(database, state, 0, found)
      }
    }

    return {
      schema: LEGACY_READ_SCHEMA,
      compatibility: LEGACY_READ_COMPATIBILITY,
      readOnly: true,
      source,
      type,
      legacyId: options.legacyId,
      row,
      warnings,
    }
  })
}
