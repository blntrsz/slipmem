import { Note } from "@slipmem/schemas/note"
import { sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"

/** Results returned when the caller does not ask for a specific limit. */
export const DEFAULT_SEARCH_LIMIT = 10

/**
 * Hard result bound. Even an untrusted or mistaken `limit` can never ask for
 * more than this many notes, which keeps the MCP/HTTP response bounded.
 */
export const MAX_SEARCH_LIMIT = 50

/**
 * Upper bound on distinct query terms. A query is caller input, so the SQL
 * statement built from it must not grow without bound.
 */
export const MAX_SEARCH_TOKENS = 16

/**
 * An opaque membership selector owned by the scope contract.
 *
 * This is a plain string so search does not depend on the scope schema. It is
 * intended to hold a `MemoryScope.Scope` value: search never parses it, it only
 * forwards it to a `SearchScopeFilter`.
 */
export type SearchScope = string

/** A note field that contributed to a match. */
export type SearchField = "title" | "content" | "reference"

export interface SearchInput {
  /** Free-form query. Empty or whitespace-only queries return no matches. */
  readonly query: string
  /**
   * Maximum number of matches. Values are clamped to `1..MAX_SEARCH_LIMIT`;
   * a missing or non-finite value uses `DEFAULT_SEARCH_LIMIT`.
   */
  readonly limit?: number
  /** Restrict results to these note kinds. Missing means every kind. */
  readonly kinds?: ReadonlyArray<Note.Kind>
  /**
   * Restrict results to one scope. Missing searches every scope.
   *
   * Scope is a namespace, not an authorization boundary: an embedding system
   * decides whether a caller may search across all scopes. When a scope is
   * supplied, search always asks the installed `SearchScopeFilter` for a
   * predicate; a filter that does not understand the scope denies that kind.
   * `UnscopedSQLiteSearchService` is the pre-migration convenience layer that
   * treats every explicit scope as visible.
   */
  readonly scope?: SearchScope
}

export interface SearchMatch {
  readonly note: Note.Info
  /** Higher is more relevant. Scores are deterministic integers. */
  readonly score: number
  /** Fields that contained at least one query term, in title/content/reference order. */
  readonly fields: ReadonlyArray<SearchField>
}

export interface SearchResult {
  /** The query as supplied by the caller. */
  readonly query: string
  /** The effective limit after clamping. */
  readonly limit: number
  /** True when at least one more match exists beyond the returned window. */
  readonly hasMore: boolean
  readonly matches: ReadonlyArray<SearchMatch>
}

export interface SearchShape {
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult>
}

export class SearchService extends Context.Service<SearchService, SearchShape>()(
  "@slipmem/core/SearchService",
) {}

/**
 * Translates an opaque scope into a SQL predicate for one note kind.
 *
 * The returned predicate is combined with the text predicate in the same
 * `WHERE` clause. Returning `undefined` means "this scope cannot see notes of
 * this kind"; search then returns no rows for that kind rather than silently
 * widening the query.
 */
export interface SearchScopeFilterShape {
  readonly where: (input: {
    readonly scope: SearchScope
    readonly kind: Note.Kind
  }) => SQL | undefined
}

export class SearchScopeFilter extends Context.Service<
  SearchScopeFilter,
  SearchScopeFilterShape
>()("@slipmem/core/SearchScopeFilter") {}

/**
 * Filter used by `UnscopedSQLiteSearchService` before the scope migration.
 *
 * It treats every scope as visible, which is equivalent to the pre-scope
 * behavior. Do not use it in a multi-tenant application; install a real
 * `SearchScopeFilter` instead.
 */
export const AllowAllSearchScopeFilterLive = Layer.succeed(
  SearchScopeFilter,
  SearchScopeFilter.of({
    where: () => sql`1 = 1`,
  }),
)
