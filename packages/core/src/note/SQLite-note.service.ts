import { Note } from "@slipmem/schemas/note"
import type { FleetingNote } from "@slipmem/schemas/fleeting-note"
import type { LiteratureNote } from "@slipmem/schemas/literature-note"
import type { MemoryScope } from "@slipmem/schemas/memory-scope"
import { MemoryScope as MemoryScopeSchema } from "@slipmem/schemas/memory-scope"
import type { PermanentNote } from "@slipmem/schemas/permanent-note"
import { Provenance } from "@slipmem/schemas/provenance"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FleetingNoteTable } from "../fleeting-note/fleeting-note.sql"
import { LiteratureNoteTable } from "../literature-note/literature-note.sql"
import { NoteDatabaseService } from "../note-database"
import { PermanentNoteTable } from "../permanent-note/permanent-note.sql"
import { NoteService } from "./note.service"

// The three note tables have different shapes, so the union selects the shared
// columns and tags each row with its kind. `reference` is NULL for kinds that
// do not have one.
interface NoteRow {
  readonly id: string
  readonly type: Note.Kind
  readonly title: string
  readonly content: string
  readonly reference: string | null
  readonly scope: MemoryScope.Scope
  readonly provenance: string
  readonly createdAt: number
  readonly updatedAt: number
}

const toInfo = (row: NoteRow): Note.Info => {
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

// Newest first, then kind and id. Ids are only unique within their own table,
// so the tie-breaker must include the kind as well.
const listOrder = sql`updated_at DESC, type ASC, id ASC`

// Every branch carries the same scope predicate. Filtering each table before
// the union keeps the query plan index-friendly and makes it impossible for a
// branch to contribute rows from another namespace.
const listQuery = (
  db: typeof NoteDatabaseService.Service,
  scope: MemoryScope.Scope,
) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      content: FleetingNoteTable.content,
      reference: sql<string | null>`NULL`.as("reference"),
      scope: FleetingNoteTable.scope,
      provenance: FleetingNoteTable.provenance,
      createdAt: FleetingNoteTable.createdAt,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .where(eq(FleetingNoteTable.scope, scope))
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          content: LiteratureNoteTable.content,
          reference: LiteratureNoteTable.reference,
          scope: LiteratureNoteTable.scope,
          provenance: LiteratureNoteTable.provenance,
          createdAt: LiteratureNoteTable.createdAt,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable)
        .where(eq(LiteratureNoteTable.scope, scope)),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          content: PermanentNoteTable.content,
          reference: sql<string | null>`NULL`.as("reference"),
          scope: PermanentNoteTable.scope,
          provenance: PermanentNoteTable.provenance,
          createdAt: PermanentNoteTable.createdAt,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable)
        .where(eq(PermanentNoteTable.scope, scope)),
    )
    .orderBy(listOrder)

const listTitlesQuery = (
  db: typeof NoteDatabaseService.Service,
  scope: MemoryScope.Scope,
) =>
  db
    .select({
      id: sql<string>`${FleetingNoteTable.id}`.as("id"),
      type: sql<Note.Kind>`'fleeting'`.as("type"),
      title: FleetingNoteTable.title,
      updatedAt: FleetingNoteTable.updatedAt,
    })
    .from(FleetingNoteTable)
    .where(eq(FleetingNoteTable.scope, scope))
    .unionAll(
      db
        .select({
          id: sql<string>`${LiteratureNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'literature'`.as("type"),
          title: LiteratureNoteTable.title,
          updatedAt: LiteratureNoteTable.updatedAt,
        })
        .from(LiteratureNoteTable)
        .where(eq(LiteratureNoteTable.scope, scope)),
    )
    .unionAll(
      db
        .select({
          id: sql<string>`${PermanentNoteTable.id}`.as("id"),
          type: sql<Note.Kind>`'permanent'`.as("type"),
          title: PermanentNoteTable.title,
          updatedAt: PermanentNoteTable.updatedAt,
        })
        .from(PermanentNoteTable)
        .where(eq(PermanentNoteTable.scope, scope)),
    )
    .orderBy(listOrder)

// Reads all three note tables directly. It deliberately does not depend on the
// per-kind note services: the database is the only dependency, and each query
// is a single UNION ALL statement over one scope.
export const SQLiteNoteService = Layer.effect(
  NoteService,
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService

    return NoteService.of({
      list: (input) => Effect.gen(function* () {
        const rows = yield* listQuery(db, input.scope ?? MemoryScopeSchema.DEFAULT_SCOPE)
        return rows.map(toInfo)
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
      listTitles: (input) => Effect.gen(function* () {
        const rows = yield* listTitlesQuery(
          db,
          input.scope ?? MemoryScopeSchema.DEFAULT_SCOPE,
        )
        return rows.map(({ id, type, title }) => ({ id, type, title }))
      }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die)),
    })
  }),
)
