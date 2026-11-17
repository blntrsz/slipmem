import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import { NoteService } from "./note.service"

type Db = typeof NoteDatabaseService.Service

// The three note tables have different shapes, so the union selects the shared
// columns and tags each row with its kind. `reference` is NULL for kinds that
// do not have one.
interface NoteRow {
  readonly id: string
  readonly type: Note.Kind
  readonly title: string
  readonly content: string
  readonly reference: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

const toInfo = (row: NoteRow): Note.Info => {
  switch (row.type) {
    case "fleeting":
      return {
        type: "fleeting",
        id: row.id as FleetingNote.ID,
        title: row.title,
        content: row.content,
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
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    case "permanent":
      return {
        type: "permanent",
        id: row.id as PermanentNote.ID,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
  }
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

// Newest first, then kind and id. Ids are only unique within their own table,
// so the tie-breaker must include the kind as well.
const byNewest = (
  left: { readonly updatedAt: number; readonly type: Note.Kind; readonly id: string },
  right: { readonly updatedAt: number; readonly type: Note.Kind; readonly id: string },
): number =>
  right.updatedAt - left.updatedAt ||
  compareText(left.type, right.type) ||
  compareText(left.id, right.id)

// Search bounds keep a caller-supplied query and limit from growing the work
// or response without bound.
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const MAX_SEARCH_TOKENS = 16
const SEARCH_FIELDS: ReadonlyArray<Note.SearchField> = ["title", "content", "reference"]
const NOTE_KINDS: ReadonlyArray<Note.Kind> = ["fleeting", "literature", "permanent"]

// Title hits are the strongest signal, references next, and body text is the
// broadest signal. Each term contributes at most once per field, so repeating
// a word in a long note cannot outrank a precise title.
const TITLE_WEIGHT = 5
const REFERENCE_WEIGHT = 3
const CONTENT_WEIGHT = 1

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

// SQLite's built-in text functions only fold ASCII case. Mirroring that rule
// keeps query matching predictable: ASCII case is ignored, while non-ASCII
// text is matched as written.
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

const tokenize = (query: string): ReadonlyArray<string> => {
  const tokens = asciiLower(query).match(TOKEN_PATTERN) ?? []
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS)
}

const effectiveSearchLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT
  }

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)))
}

const matches = (value: string, token: string): boolean =>
  asciiLower(value).includes(token)

// A token contributes at most once per field, so repeating a word cannot
// inflate a note's rank.
const tokenScore = (
  row: NoteRow,
  token: string,
  fields: ReadonlySet<Note.SearchField>,
): number => {
  const title = fields.has("title") && matches(row.title, token) ? TITLE_WEIGHT : 0
  const content =
    fields.has("content") && matches(row.content, token) ? CONTENT_WEIGHT : 0
  const reference =
    fields.has("reference") &&
    row.reference !== null &&
    matches(row.reference, token)
      ? REFERENCE_WEIGHT
      : 0

  return title + content + reference
}

const searchScore = (
  row: NoteRow,
  tokens: ReadonlyArray<string>,
  fields: ReadonlySet<Note.SearchField>,
): number =>
  tokens.reduce((total, token) => total + tokenScore(row, token, fields), 0)

const listRows = (db: Db) =>
  Effect.gen(function* () {
    const fleeting = yield* db
      .select({
        id: FleetingNoteTable.id,
        title: FleetingNoteTable.title,
        content: FleetingNoteTable.content,
        createdAt: FleetingNoteTable.createdAt,
        updatedAt: FleetingNoteTable.updatedAt,
      })
      .from(FleetingNoteTable)
    const literature = yield* db
      .select({
        id: LiteratureNoteTable.id,
        title: LiteratureNoteTable.title,
        content: LiteratureNoteTable.content,
        reference: LiteratureNoteTable.reference,
        createdAt: LiteratureNoteTable.createdAt,
        updatedAt: LiteratureNoteTable.updatedAt,
      })
      .from(LiteratureNoteTable)
    const permanent = yield* db
      .select({
        id: PermanentNoteTable.id,
        title: PermanentNoteTable.title,
        content: PermanentNoteTable.content,
        createdAt: PermanentNoteTable.createdAt,
        updatedAt: PermanentNoteTable.updatedAt,
      })
      .from(PermanentNoteTable)

    return [
      ...fleeting.map((row) => ({
        ...row,
        type: "fleeting" as const,
        reference: null,
      })),
      ...literature.map((row) => ({ ...row, type: "literature" as const })),
      ...permanent.map((row) => ({
        ...row,
        type: "permanent" as const,
        reference: null,
      })),
    ].sort(byNewest)
  })

const titleRows = (db: Db) =>
  Effect.gen(function* () {
    const fleeting = yield* db
      .select({
        id: FleetingNoteTable.id,
        title: FleetingNoteTable.title,
        updatedAt: FleetingNoteTable.updatedAt,
      })
      .from(FleetingNoteTable)
    const literature = yield* db
      .select({
        id: LiteratureNoteTable.id,
        title: LiteratureNoteTable.title,
        updatedAt: LiteratureNoteTable.updatedAt,
      })
      .from(LiteratureNoteTable)
    const permanent = yield* db
      .select({
        id: PermanentNoteTable.id,
        title: PermanentNoteTable.title,
        updatedAt: PermanentNoteTable.updatedAt,
      })
      .from(PermanentNoteTable)

    return [
      ...fleeting.map((row) => ({ ...row, type: "fleeting" as const })),
      ...literature.map((row) => ({ ...row, type: "literature" as const })),
      ...permanent.map((row) => ({ ...row, type: "permanent" as const })),
    ].sort(byNewest)
  })

const searchRows = (db: Db, input: Note.SearchInput) =>
  Effect.gen(function* () {
    const tokens = tokenize(input.query)
    const limit = effectiveSearchLimit(input.limit)
    const fields = new Set<Note.SearchField>(input.fields ?? SEARCH_FIELDS)
    const kinds = new Set<Note.Kind>(input.kinds ?? NOTE_KINDS)

    if (tokens.length === 0 || fields.size === 0 || kinds.size === 0) {
      return []
    }

    // Matching and weighted ranking live in JavaScript so search uses one
    // expression builder (Drizzle selects) and one definition of "matches".
    // The tradeoff is that every search reads all notes from the selected
    // kinds before cutting the top `limit`; local note databases are small and
    // the simpler, single matching rule is worth it.
    const rows = (yield* listRows(db)).filter((row) => kinds.has(row.type))

    return rows
      .filter((row) =>
        tokens.every((token) => tokenScore(row, token, fields) > 0),
      )
      .map((row) => ({ row, score: searchScore(row, tokens, fields) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          byNewest(left.row, right.row),
      )
      .slice(0, limit)
      .map(({ row }) => toInfo(row))
  })

// Reads all three note tables directly. It deliberately does not depend on the
// per-kind note services: the database is the only dependency.
export const SQLiteNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService

    return NoteService.of({
      list: (_input) =>
        listRows(db).pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
          Effect.map((rows) => rows.map(toInfo)),
        ),
      listTitles: (_input) =>
        titleRows(db).pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
          Effect.map((rows) =>
            rows.map(({ id, type, title }) => ({ id, type, title })),
          ),
        ),
      search: (input) =>
        searchRows(db, input).pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
        ),
    })
  }),
)
