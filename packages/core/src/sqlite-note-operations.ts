import { desc, eq } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { AnyColumn } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Option } from "effect"
import { NoteDatabaseService } from "./note-database"

type NoteTable = AnySQLiteTable & {
  readonly id: AnyColumn
  readonly updatedAt: AnyColumn
  readonly $inferInsert: Record<string, unknown>
  readonly $inferSelect: Record<string, unknown>
}

interface NoteOperationsOptions<
  Table extends NoteTable,
  Id extends string,
  Info,
  CreateInput,
  UpdateInput extends { readonly id: Id },
  NotFound,
> {
  readonly table: Table
  readonly createValues: (input: CreateInput) => Table["$inferInsert"]
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

/**
 * Implements the identical CRUD surface of a single note slice.
 *
 * The per-kind services only contribute their table, input mapping, output
 * mapping, and not-found error. Keeping the query shapes here means list order
 * and error handling cannot drift between fleeting, literature, and permanent
 * notes.
 */
export const makeSQLiteNoteOperations = <
  Table extends NoteTable,
  Id extends string,
  Info,
  CreateInput,
  UpdateInput extends { readonly id: Id },
  NotFound,
>(
  options: NoteOperationsOptions<Table, Id, Info, CreateInput, UpdateInput, NotFound>,
): Effect.Effect<
  {
    readonly create: (input: CreateInput) => Effect.Effect<Info>
    readonly get: (input: { readonly id: Id }) => Effect.Effect<Option.Option<Info>>
    readonly list: () => Effect.Effect<ReadonlyArray<Info>>
    readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFound>
    readonly delete: (input: { readonly id: Id }) => Effect.Effect<boolean>
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
              .values(createValues(input) as never)
              .returning(),
          ),
          (rows) => toInfo(rows[0]! as Table["$inferSelect"]),
        ),
      get: (input) =>
        Effect.map(
          query(db.select().from(table).where(eq(table.id, input.id))),
          (rows) =>
            Option.fromNullishOr(rows[0]).pipe(
              Option.map((row) => toInfo(row as Table["$inferSelect"])),
            ),
        ),
      list: () =>
        Effect.map(
          query(
            db
              .select()
              .from(table)
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
              .where(eq(table.id, input.id))
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
              .where(eq(table.id, input.id))
              .returning({ id: table.id }),
          ),
          (rows) => rows.length > 0,
        ),
    }
  })
