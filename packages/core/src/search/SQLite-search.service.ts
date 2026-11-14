import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { MemoryScope } from "@slipmem/schemas/memory-scope"
import { MemoryScope as MemoryScopeSchema } from "@slipmem/schemas/memory-scope"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Provenance } from "@slipmem/schemas/provenance"
import {
  and,
  eq,
  or,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  SearchService,
  type SearchField,
  type SearchInput,
  type SearchMatch,
  type SearchResult,
  type SearchShape,
} from "./search.service"

// Title hits are the strongest signal, references next, and body text is the
// broadest signal. Every term contributes at most once per field, which keeps
// a long note from outranking a precise title only by repeating a word.
const TITLE_WEIGHT = 5
const REFERENCE_WEIGHT = 3
const CONTENT_WEIGHT = 1

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

// SQLite's `lower` is ASCII-only. Mirroring that rule in JavaScript keeps the
// SQL score and the reported `fields` consistent: ASCII is case-insensitive,
// non-ASCII is case-sensitive.
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

/**
 * Normalizes a query into distinct lowercase terms.
 *
 * The token count is bounded because it determines the size of the generated
 * SQL expression. Unicode letters and numbers are accepted; punctuation is a
 * separator.
 */
const tokenize = (query: string): ReadonlyArray<string> => {
  const tokens = asciiLower(query).match(TOKEN_PATTERN) ?? []
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS)
}

const effectiveLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT
  }

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)))
}

const normalized = (value: string): string => asciiLower(value)

const matchedFields = (row: SearchRow, tokens: ReadonlyArray<string>): ReadonlyArray<SearchField> => {
  const title = normalized(row.title)
  const content = normalized(row.content)
  const reference = normalized(row.reference ?? "")
  const fields: Array<SearchField> = []

  if (tokens.some((token) => title.includes(token))) {
    fields.push("title")
  }
  if (tokens.some((token) => content.includes(token))) {
    fields.push("content")
  }
  if (tokens.some((token) => reference.includes(token))) {
    fields.push("reference")
  }

  return fields
}

// SQLite's `lower` is ASCII-only. Non-ASCII case folding therefore behaves
// like an exact match; the tokenizer still splits Unicode text correctly.
const contains = (column: SQLWrapper, token: string): SQL<boolean> =>
  sql<boolean>`instr(lower(coalesce(${column}, '')), ${token}) > 0`

const fieldScore = (input: {
  readonly title: SQLWrapper
  readonly content: SQLWrapper
  readonly reference: SQLWrapper
  readonly token: string
}): SQL<number> =>
  sql<number>`(
    (instr(lower(${input.title}), ${input.token}) > 0) * ${TITLE_WEIGHT} +
    (instr(lower(coalesce(${input.reference}, '')), ${input.token}) > 0) * ${REFERENCE_WEIGHT} +
    (instr(lower(${input.content}), ${input.token}) > 0) * ${CONTENT_WEIGHT}
  )`

interface SearchTable extends AnySQLiteTable {
  readonly id: AnyColumn
  readonly title: AnyColumn
  readonly content: AnyColumn
  readonly scope: AnyColumn
  readonly provenance: AnyColumn
  readonly createdAt: AnyColumn
  readonly updatedAt: AnyColumn
}

interface SearchRow {
  readonly id: string
  readonly type: Note.Kind
  readonly title: string
  readonly content: string
  readonly reference: string | null
  readonly scope: MemoryScope.Scope
  readonly provenance: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly score: number
}

const buildKindQuery = (
  db: typeof NoteDatabaseService.Service,
  input: {
    readonly kind: Note.Kind
    readonly table: SearchTable
    /** A real reference column, or the SQL NULL literal for kinds without one. */
    readonly reference: SQLWrapper
    readonly tokens: ReadonlyArray<string>
    readonly scope: MemoryScope.Scope
  },
) => {
  const { kind, table, reference, tokens, scope } = input

  const textCondition = and(
    ...tokens.map((token) =>
      or(
        contains(table.title, token),
        contains(table.content, token),
        contains(reference, token),
      ),
    ),
  )!

  const score = tokens
    .map((token) =>
      fieldScore({
        title: table.title,
        content: table.content,
        reference,
        token,
      }),
    )
    .reduce<SQL<number>>((total, part) => sql<number>`${total} + ${part}`, sql<number>`0`)

  return db
    .select({
      id: sql<string>`${table.id}`.as("id"),
      type: sql<Note.Kind>`'${sql.raw(kind)}'`.as("type"),
      title: sql<string>`${table.title}`.as("title"),
      content: sql<string>`${table.content}`.as("content"),
      reference: sql<string | null>`${reference}`.as("reference"),
      scope: sql<MemoryScope.Scope>`${table.scope}`.as("scope"),
      provenance: sql<string>`${table.provenance}`.as("provenance"),
      createdAt: sql<number>`${table.createdAt}`.as("created_at"),
      updatedAt: sql<number>`${table.updatedAt}`.as("updated_at"),
      score: score.as("score"),
    })
    .from(table)
    .where(and(textCondition, eq(table.scope, scope)))
}

// The three note kinds have different id brands, so each branch casts its row
// id back to the schema brand. Scope and provenance are decoded exactly like
// the aggregate note list does.
const toInfo = (row: SearchRow): Note.Info => {
  const provenance = Provenance.decode(row.provenance)

  switch (row.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: row.id as FleetingNote.ID,
        title: row.title,
        content: row.content,
        scope: row.scope,
        provenance,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "literature":
      return {
        type: "literature",
        id: row.id as LiteratureNote.ID,
        title: row.title,
        content: row.content,
        reference: row.reference ?? "",
        scope: row.scope,
        provenance,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "permanent":
      return {
        type: "permanent",
        id: row.id as PermanentNote.ID,
        title: row.title,
        content: row.content,
        scope: row.scope,
        provenance,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
  }
}

const toMatch = (row: SearchRow, tokens: ReadonlyArray<string>): SearchMatch => ({
  note: toInfo(row),
  score: row.score,
  fields: matchedFields(row, tokens),
})

const search = (
  db: typeof NoteDatabaseService.Service,
  input: SearchInput,
): Effect.Effect<SearchResult> =>
  Effect.gen(function* () {
    const tokens = tokenize(input.query)
    const limit = effectiveLimit(input.limit)
    const scope = input.scope ?? MemoryScopeSchema.DEFAULT_SCOPE
    const kinds = new Set<Note.Kind>(input.kinds ?? ["fleeting", "literature", "permanent"])

    if (tokens.length === 0 || kinds.size === 0) {
      return {
        query: input.query,
        limit,
        hasMore: false,
        matches: [],
      }
    }

    const queries: Array<{
      readonly kind: Note.Kind
      readonly query: ReturnType<typeof buildKindQuery>
    }> = []

    if (kinds.has("fleeting")) {
      queries.push({
        kind: "fleeting",
        query: buildKindQuery(db, {
          kind: "fleeting",
          table: FleetingNoteTable,
          reference: sql<string | null>`NULL`,
          tokens,
          scope,
        }),
      })
    }
    if (kinds.has("literature")) {
      queries.push({
        kind: "literature",
        query: buildKindQuery(db, {
          kind: "literature",
          table: LiteratureNoteTable,
          reference: LiteratureNoteTable.reference,
          tokens,
          scope,
        }),
      })
    }
    if (kinds.has("permanent")) {
      queries.push({
        kind: "permanent",
        query: buildKindQuery(db, {
          kind: "permanent",
          table: PermanentNoteTable,
          reference: sql<string | null>`NULL`,
          tokens,
          scope,
        }),
      })
    }

    // Query each kind separately instead of building one UNION. The global
    // top `limit` results contain at most `limit` rows from any one kind, so
    // fetching `limit + 1` per kind is enough both to rank globally and to
    // detect whether more matches exist. This also keeps each statement
    // bounded (at most three statements, each with a small LIMIT).
    const rows: Array<SearchRow> = []
    for (const { query } of queries) {
      const kindRows = (yield* query
        .orderBy(sql`score DESC, updated_at DESC, type ASC, id ASC`)
        .limit(limit + 1)) as ReadonlyArray<SearchRow>
      rows.push(...kindRows)
    }

    rows.sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt - left.updatedAt ||
        (left.type < right.type ? -1 : left.type > right.type ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )

    const window = rows.slice(0, limit)

    return {
      query: input.query,
      limit,
      hasMore: rows.length > limit,
      matches: window.map((row) => toMatch(row, tokens)),
    }
  }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))

export const SQLiteSearchService = Layer.effect(
  SearchService,
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService

    const implementation: SearchShape = {
      search: (input) => search(db, input),
    }

    return SearchService.of(implementation)
  }),
)

export type { SearchInput, SearchMatch, SearchResult, SearchScope } from "./search.service"
