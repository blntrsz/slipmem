import { and, desc, eq } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { AnyColumn } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { MemoryScope } from "@slipmem/schemas/memory-scope"
import { MemoryScope as MemoryScopeSchema } from "@slipmem/schemas/memory-scope"
import { Provenance } from "@slipmem/schemas/provenance"
import { Effect, Option } from "effect"
import { NoteDatabaseService } from "./note-database"

type NoteTable = AnySQLiteTable & {
  readonly id: AnyColumn
  readonly scope: AnyColumn
  readonly updatedAt: AnyColumn
  readonly $inferInsert: Record<string, unknown>
  readonly $inferSelect: Record<string, unknown>
}

interface ScopedInput {
  readonly scope?: MemoryScope.Scope
}

interface NoteOperationsOptions<
  Table extends NoteTable,
  Id extends string,
  Info,
  CreateInput extends ScopedInput & { readonly provenance?: Provenance.Info },
  UpdateInput extends { readonly id: Id } & ScopedInput,
  NotFound,
> {
  readonly table: Table
  /** Maps user-authored create fields. Scope and provenance are added below. */
  readonly createValues: (input: CreateInput) => Table["$inferInsert"]
  /** Maps the mutable fields of an update. Scope and provenance are immutable. */
  readonly updateValues: (input: UpdateInput) => Table["$inferInsert"]
  readonly toInfo: (row: Table["$inferSelect"]) => Info
  readonly notFound: (id: Id) => NotFound
}

// Drizzle's query errors are infrastructure failures, not domain results. All
// note services surface them as defects so callers never mistake a broken
// database for a missing note.
const query = <A>(
  effect: Effect.Effect<A, EffectDrizzleQueryError>,
): Effect.Effect<A> => effect.pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))

// Pre-scope callers and existing editors omit `scope`. That means the default
// namespace, which is exactly where the migration adopted every legacy row.
const scopeOf = (input: ScopedInput): MemoryScope.Scope =>
  input.scope ?? MemoryScopeSchema.DEFAULT_SCOPE

const scopedId = <Id extends string>(
  table: NoteTable,
  id: Id,
  scope: MemoryScope.Scope,
) => and(eq(table.id, id), eq(table.scope, scope))

/**
 * Implements the identical scoped CRUD surface of a single note slice.
 *
 * Scope isolation lives here rather than in each slice: every primary-key read,
 * update, and delete includes the scope predicate, and every list is filtered
 * by scope. A note's id is never sufficient to reach it from another
 * namespace; a cross-scope lookup is indistinguishable from a missing note.
 *
 * The per-kind services only contribute their table, input mapping, output
 * mapping, and not-found error. Keeping the query shapes here means list order,
 * scope filtering, and error handling cannot drift between fleeting,
 * literature, and permanent notes.
 */
export const makeSQLiteNoteOperations = <
  Table extends NoteTable,
  Id extends string,
  Info,
  CreateInput extends ScopedInput & { readonly provenance?: Provenance.Info },
  UpdateInput extends { readonly id: Id } & ScopedInput,
  NotFound,
>(
  options: NoteOperationsOptions<Table, Id, Info, CreateInput, UpdateInput, NotFound>,
): Effect.Effect<
  {
    readonly create: (input: CreateInput) => Effect.Effect<Info>
    readonly get: (
      input: { readonly id: Id } & ScopedInput,
    ) => Effect.Effect<Option.Option<Info>>
    readonly list: (input: ScopedInput) => Effect.Effect<ReadonlyArray<Info>>
    readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFound>
    readonly delete: (input: { readonly id: Id } & ScopedInput) => Effect.Effect<boolean>
  },
  never,
  NoteDatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* NoteDatabaseService
    const { table, createValues, updateValues, toInfo, notFound } = options

    return {
      create: (input) =>
        Effect.map(
          query(
            db
              .insert(table)
              .values({
                ...createValues(input),
                scope: scopeOf(input),
                provenance: Provenance.encode(input.provenance ?? Provenance.UNKNOWN),
              } as never)
              .returning(),
          ),
          (rows) => toInfo(rows[0]! as Table["$inferSelect"]),
        ),
      get: (input) =>
        Effect.map(
          query(
            db
              .select()
              .from(table)
              .where(scopedId(table, input.id, scopeOf(input))),
          ),
          (rows) =>
            Option.fromNullishOr(rows[0]).pipe(
              Option.map((row) => toInfo(row as Table["$inferSelect"])),
            ),
        ),
      list: (input) =>
        Effect.map(
          query(
            db
              .select()
              .from(table)
              .where(eq(table.scope, scopeOf(input)))
              .orderBy(desc(table.updatedAt), table.id),
          ),
          (rows) => rows.map((row) => toInfo(row as Table["$inferSelect"])),
        ),
      update: (input) =>
        Effect.gen(function* () {
          const rows = yield* query(
            db
              .update(table)
              .set(updateValues(input) as never)
              .where(scopedId(table, input.id, scopeOf(input)))
              .returning(),
          )
          const row = rows[0]
          if (row === undefined) {
            return yield* Effect.fail(notFound(input.id))
          }

          return toInfo(row as Table["$inferSelect"])
        }),
      delete: (input) =>
        Effect.map(
          query(
            db
              .delete(table)
              .where(scopedId(table, input.id, scopeOf(input)))
              .returning({ id: table.id }),
          ),
          (rows) => rows.length > 0,
        ),
    }
  })
