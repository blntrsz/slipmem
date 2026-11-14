# Bounded ranked cross-kind search

`SearchService` is a read-only memory search across all three note kinds. It
reuses the existing note tables, including the `scope` and `provenance` columns
from the scope contract, and requires no migration or search index of its own.

## Interface

```ts
interface SearchInput {
  query: string
  limit?: number              // clamped to 1..50, default 10
  kinds?: Note.Kind[]         // default: all three kinds
  scope?: SearchScope         // default: MemoryScope.DEFAULT_SCOPE
}

interface SearchMatch {
  note: Note.Info
  score: number
  fields: ("title" | "content" | "reference")[]
}

interface SearchResult {
  query: string
  limit: number
  hasMore: boolean
  matches: SearchMatch[]
}
```

`SearchScope` is `MemoryScope.Scope` from `@slipmem/schemas/memory-scope`, so
search and the note services share one branded scope type. `SearchService` is a
`Context.Service`; `SQLiteSearchService` is the SQLite implementation and needs
only `NoteDatabaseService`.

## Scope filtering

Every per-kind query includes `scope = ?` in its `WHERE` clause before ranking
or limiting. A note from another scope can never enter the candidate set, even
when a broad limit is requested.

`SearchInput.scope` is optional. Omitting it uses
`MemoryScope.DEFAULT_SCOPE` (`global`), matching the note services, the JSON
API, and MCP. Cross-scope search is intentionally not part of this contract; a
future operation that needs it should make that choice explicit rather than
overloading the missing-scope case.

## Ranking

Queries are lowercased (ASCII only, matching SQLite), split on
non-letter/non-digit characters, deduplicated, and capped at 16 terms. Terms
combine with `AND`: every term must appear in at least one of title, content,
or reference. Within a term, fields combine with `OR`. Each distinct term
contributes at most once per field:

| Field     | Weight |
| --------- | ------ |
| title     | 5      |
| reference | 3      |
| content   | 1      |

The resulting integer is `score`. Ties are broken by `updatedAt` descending,
then kind (`fleeting`, `literature`, `permanent`), then id. This is deliberately
simple and deterministic; it is not BM25 or a semantic embedding search.

SQLite's built-in `lower()` only folds ASCII case. Non-ASCII text still matches
case-sensitively, and the tokenizer still splits it correctly.

## Bounds

* Results: `limit` is clamped to `1..50`; the default is `10`.
* Query: at most 16 distinct terms feed the generated SQL.
* Work: each kind is queried separately with `LIMIT limit + 1`, so the service
  performs at most three small statements regardless of corpus size. The extra
  row per kind is how `hasMore` is computed without an unbounded count query.
* Response: matches contain full `Note.Info` values, so `MAX_SEARCH_LIMIT`
  bounds the amount of content returned.

The scoped top `limit` results can contain at most `limit` rows from any single
kind, so fetching `limit + 1` per kind and merging in memory is equivalent to a
global top-K query for the supported scoring function.

Empty or punctuation-only queries return no matches before touching SQL.

## Contract alignment

This implementation is based on `scope-contract` commit `765d1d8`:

* `SearchScope` is `MemoryScope.Scope`; IDs, scope, and provenance are mapped
  into the same `Note.Info` union as the note services.
* Every query filters `scope` in SQL and defaults to `MemoryScope.DEFAULT_SCOPE`.
* Rows include the decoded `provenance` envelope and the note's own scope.
* No schema, migration, CRUD, or scope code is changed by this work.

## Transport integration

The MCP integration is implemented in `packages/server/src/note-tools.ts` as
the `search_notes` tool. It is registered once in `NoteRegistrations`, so the
stdio server and the streamable HTTP `/mcp` endpoint expose identical input and
output schemas. `packages/server/src/database.ts` builds `SQLiteSearchService`
alongside the note services, which is what satisfies the registration layer.

The tool input follows `SearchInput` and reuses `MemoryScope.Scope`, so a
malformed scope is rejected by the tool schema before search runs. The success
shape is the full `SearchResult`, including `query`, the effective `limit`,
`hasMore`, and `matches`. This milestone returns full note content rather than
snippets; `MAX_SEARCH_LIMIT` is the payload bound. The MCP README records the
security limitations of that choice, including the fact that scope is a
namespace rather than an authorization check.

A future HTTP JSON search route would still need its own input schema and error
mapping. It does not need a new database table or index.

## Tests

`SQLite-search.service.test.ts` covers cross-kind ranking, weighted fields,
term deduplication and AND matching, deterministic tie-breaking, limit clamping
and `hasMore`, kind filters, empty queries, ASCII case folding, punctuation and
operator-as-term handling, scope filtering composing with kind and limit,
default-scope behavior, `scope`/`provenance` in results, and SQL error
propagation.
