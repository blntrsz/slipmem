import { Note } from "@slipmem/schemas/note"
import type { MemoryScope } from "@slipmem/schemas/memory-scope"
import { Context, Effect } from "effect"

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
 * A note's memory namespace, re-exported from the scope contract.
 *
 * Search uses the same branded value as the note services so a scope cannot be
 * passed to one surface and silently misinterpreted by another.
 */
export type SearchScope = MemoryScope.Scope

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
   * Restrict results to one scope. Missing uses `MemoryScope.DEFAULT_SCOPE`
   * (`global`), matching every other note read.
   *
   * Every per-kind query adds `scope = ?` to its SQL predicate before ranking
   * or limiting, so a scope cannot leak rows from another namespace.
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
