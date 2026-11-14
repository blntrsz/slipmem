# Bounded ranked cross-kind search

`SearchService` is a read-only memory search across all three note kinds. It
reuses the existing note tables and requires no migration or index of its own.

## Interface

```ts
interface SearchInput {
  query: string
  limit?: number              // clamped to 1..50, default 10
  kinds?: Note.Kind[]         // default: all three kinds
  scope?: SearchScope         // default: search every scope
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

`SearchService` is a `Context.Service`; the SQLite implementation is
`SQLiteSearchService`. Callers that exist before the scope migration can use the
`UnscopedSQLiteSearchService` convenience layer, which makes every scope
visible.

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

The global top `limit` results can contain at most `limit` rows from any single
kind, so fetching `limit + 1` per kind and merging in memory is equivalent to a
global top-K query for the supported scoring function.

Empty or punctuation-only queries return no matches before touching SQL.

## Scope integration

Search does not own the scope schema or migration. It treats a scope as an
opaque string (`SearchScope`) and resolves it through one service:

```ts
interface SearchScopeFilterShape {
  where(input: {
    scope: SearchScope
    kind: Note.Kind
  }): SQL | undefined   // undefined denies that kind
}
```

Assumptions for the scope contract:

1. A scope is a string. `SearchScope` is structurally compatible with
   `MemoryScope.Scope`; importing the branded schema is an integration choice,
   not a dependency of search.
2. An omitted `SearchInput.scope` searches every scope. Scope is a namespace,
   not an authorization boundary, so cross-scope recall is the default for
   search while note CRUD defaults to `MemoryScope.DEFAULT_SCOPE`. Transports
   that want a default-scope search must pass that scope explicitly.
3. An explicit scope is resolved by the installed filter. The filter must
   produce a SQL predicate for every kind; returning `undefined` means "not
   visible" and search returns no rows for that kind. It never widens to an
   unscoped query.
4. Once the scope migration adds a `scope` column to each note table, provide a
   filter layer instead of `UnscopedSQLiteSearchService`:

   ```ts
   import { eq } from "drizzle-orm"
   import { Layer } from "effect"
   import { SearchScopeFilter } from "@slipmem/core"
   import { FleetingNoteTable } from "./fleeting-note/fleeting-note.sql"
   import { LiteratureNoteTable } from "./literature-note/literature-note.sql"
   import { PermanentNoteTable } from "./permanent-note/permanent-note.sql"

   export const ScopedSearchScopeFilterLive = Layer.succeed(
     SearchScopeFilter,
     SearchScopeFilter.of({
       where: ({ scope, kind }) => {
         switch (kind) {
           case "fleeting":
             return eq(FleetingNoteTable.scope, scope)
           case "literature":
             return eq(LiteratureNoteTable.scope, scope)
           case "permanent":
             return eq(PermanentNoteTable.scope, scope)
         }
       },
     }),
   )
   ```

   That layer can live inside `packages/core` (where the tables are already
   imported) or another package if the table modules are exported there.

5. When `Note.Info` gains required fields (for example `scope` and
   `provenance`), `SQLite-search.service.ts` must select and map those columns
   in `SearchRow`/`toInfo` alongside the other note reads. Search intentionally
   keeps its own row mapper so this change is local and explicit.

## Transport integration (not implemented here)

The same service can back the HTTP API and MCP tool once their input schemas
exist, for example:

* `POST /api/search` with `{ query, limit?, kinds?, scope? }`
* MCP `search_notes` returning `{ matches, hasMore, limit }`

Both transports should validate input first and pass the resolved scope from
their own scope handling. Neither needs a new database table.

## Tests

`SQLite-search.service.test.ts` covers cross-kind ranking, weighted fields,
term deduplication and AND matching, deterministic tie-breaking, limit clamping
and `hasMore`, kind filters, empty queries, ASCII case folding, punctuation and
operator-as-term handling, scope filtering with a custom predicate, cross-scope
search when scope is omitted, the unscoped convenience layer, and SQL error
propagation.
