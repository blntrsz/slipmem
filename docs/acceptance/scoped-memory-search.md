# Scoped memory and search — acceptance test plan

Status: **blocked on the scope/search contract**. No automated test in this
worktree imports a scope or search API, because the contract is being developed
separately. This document and the fixtures under
`tests/fixtures/scoped-memory/` are the hand-off: once the contract names its
types, operations, and wire fields, the cases below can be turned into tests
without re-deciding behavior.

Related worktrees (context pointers, not dependencies):

- `scope-contract` — scope semantics and data model
- `bounded-ranked-search` — search semantics and bounded result contracts

## Fixtures

| Path | Purpose |
| --- | --- |
| `tests/fixtures/scoped-memory/corpus.json` | Deterministic notes across three scopes, three note kinds, duplicate titles, unicode, punctuation, and title/content/reference-only matches. |
| `tests/fixtures/scoped-memory/search-cases.json` | Search vectors with exact expected key sets where the answer does not depend on ranking; open questions are named per case. |
| `tests/fixtures/scoped-memory/legacy-v1.sql` | Populated pre-scope database in the frozen legacy bootstrap shape. |
| `tests/fixtures/scoped-memory/legacy-v1.manifest.json` | The rows the migration must preserve and the fields that must be unchanged. |
| `tests/fixtures/scoped-memory/README.md` | Fixture semantics and a loading sketch. |

Fixtures use stable, human-readable ids and fixed timestamps so ordering and
tie-break assertions can be exact. They are data, not a proposed API: adapters
in the eventual tests map `scope`/`query`/`kind`/`limit` onto whatever names the
contract chooses.

## Contract decisions that block automation

These must be answered by the scope/search contract before assertions are
committed:

1. Scope representation: free-form string, enum, hierarchical path, or a
   separate scopes table with ids.
2. Default scope when omitted on create, and whether reads require an explicit
   scope or return all scopes tagged with their scope.
3. Whether a note's scope is mutable via update, and whether moving a scope is
   an update or a separate operation.
4. Search matching: substring, token/prefix, FTS5, or another index; which
   fields are searched (title, content, reference); and how multi-term queries
   combine (`AND`, phrase, `OR`).
5. Case folding, accent folding, and punctuation/tokenizer behavior.
6. Ranking: exact signals, tie-break, and whether ranking is stable across
   identical `updatedAt` values.
7. Pagination contract: limit/offset or cursor, default and maximum limits,
   empty/whitespace queries, and whether totals are returned.
8. Whether unscoped/global notes are visible from project scopes, or only when
   searching/listing explicitly across scopes.
9. Migration behavior for existing rows: default scope value, index backfill,
   and whether the migration is reversible.
10. Wire compatibility: whether existing list/get/update/delete tools and API
    paths keep their current shape, or gain optional scope parameters.

## Proposed acceptance cases

### Scope isolation

| ID | Preconditions | Action | Expected |
| --- | --- | --- | --- |
| SCOPE-01 | Empty database, contract default scope `D` | Create a note without a scope | Stored note has scope `D`; response exposes the scope field |
| SCOPE-02 | Empty database | Create one note in `project-alpha` and one in `project-beta` | Each note round-trips its own scope; no cross-assignment |
| SCOPE-03 | Corpus loaded | List `project-alpha` notes | Exactly the alpha keys; no beta or global keys, unless the contract says global is inherited |
| SCOPE-04 | Corpus loaded | Get a `project-beta` note while reading as `project-alpha` | Contract-specified non-leak result: not found, null, or explicit forbidden failure — never the note body |
| SCOPE-05 | One alpha note | Update title/content without changing scope | Scope is unchanged; only writable fields change |
| SCOPE-06 | One alpha note | Move the note to `project-beta` if the contract allows it | Old scope no longer returns it; new scope does; search reflects the move |
| SCOPE-07 | Empty database | Create with empty, whitespace-only, overlong, or malformed scope | Validation failure with an actionable message; no row written |
| SCOPE-08 | One alpha note | Delete while reading as beta | Contract-specified non-leak behavior; alpha delete still works |

### Search behavior

Fixture keys below refer to `corpus.json`.

| ID | Query | Filter | Expected |
| --- | --- | --- | --- |
| SEARCH-01 | `Scoped memory` (mixed case) | none | Key set `alpha-permanent-migration`, `beta-fleeting-title-only`; ordering contract-defined |
| SEARCH-02 | `legacy database` | none | Only `alpha-permanent-migration` (content-only match) |
| SEARCH-03 | `chapter 3` | none | `alpha-literature-ranking`, `beta-literature-source` (reference-only matches) |
| SEARCH-04 | `migration` | scope `project-alpha` | `alpha-permanent-migration`, `alpha-fleeting-index` |
| SEARCH-05 | `migration` | none | `alpha-permanent-migration`, `alpha-fleeting-index`, `beta-permanent-migration`, `beta-permanent-duplicate-title`, `global-permanent-migration` |
| SEARCH-06 | `migration` | kind `fleeting` | Only `alpha-fleeting-index` |
| SEARCH-07 | `rollback` | scope `project-alpha` | Empty result: beta matches must not leak |
| SEARCH-08 | `rollback plan` | scope `project-beta` | Both beta permanents; ties on `updatedAt` must break deterministically and repeatably |
| SEARCH-09 | `node.js` | none | `global-fleeting-punctuation`; tokenizer may require an exact-token assertion |
| SEARCH-10 | `café` | none | `alpha-fleeting-unicode`; decide whether unaccented `cafe` also matches |
| SEARCH-11 | `" OR 1=1 --` | none | Empty result, no error, no query interpolation; database still readable |
| SEARCH-12 | `migration` | none, limit 2 | Two distinct keys from the SEARCH-05 set; no duplicates; deterministic ordering |
| SEARCH-13 | `   ` | none | Contract-defined: empty result (preferred) or bounded full listing; never an unbounded scan error |
| SEARCH-14 | `needle-at-end` (in `alpha-permanent-long`) | none | Term at the end of the content is found; result still respects the content limit |
| SEARCH-15 | `rollback` | scope `project-beta`, kind `permanent` | Both beta permanents; kind and scope filters compose |
| SEARCH-DYN-01 | `fresh-term` after updating a note to contain it | none | Updated note appears; before update it did not |
| SEARCH-DYN-02 | `rollback` after deleting both beta permanents | scope `project-beta` | Deleted notes are absent; no stale index row |

Search cases that need an explicit ranking assertion should be added only after
the bounded-ranked-search contract fixes the ordering signals. Until then,
assert key sets and determinism, not a specific rank order.

### Migration compatibility

| ID | Preconditions | Action | Expected |
| --- | --- | --- | --- |
| MIG-SCOPE-01 | `legacy-v1.sql` applied to a file | Run startup once | Every manifest row still exists with id, title, content, reference, and timestamps unchanged |
| MIG-SCOPE-02 | Same | Inspect migrated rows | Every row has the contract's default scope, including rows that previously had none |
| MIG-SCOPE-03 | Same | Search for `migration` and `chapter 3` after startup | Legacy rows are indexed and findable; no manual reindex step |
| MIG-SCOPE-04 | Same | Run startup three times | Applied history has one row per checked-in migration; note count and field values do not change |
| MIG-SCOPE-05 | Legacy database plus an unrelated table/index | Run startup | Unrelated objects and rows are untouched |
| MIG-SCOPE-06 | Legacy note table with a partial/extra scope column | Run startup | `MigrationError`; rows remain byte-identical; no migration history is recorded |
| MIG-SCOPE-07 | Legacy database read by both API and stdio MCP | Start both against the file | Both surfaces see the same scoped rows and default scope |
| MIG-SCOPE-08 | Database after scope migration | Apply the same migration again | No duplicate scope columns, rows, or index entries; startup stays idempotent |

The general, already-automated migration checks live in
`packages/server/src/migration-compatibility.test.ts`. Extend them with the
scope-specific rows once the migration exists.

### MCP behavior

| ID | Action | Expected |
| --- | --- | --- |
| MCP-SCOPE-01 | `initialize` and `tools/list` | Existing tool names remain, or the contract explicitly versions/renames them; new search/scope tools are listed with valid input/output schemas |
| MCP-SCOPE-02 | Create through MCP with an explicit scope | Response includes the same scope; a follow-up get/list in that scope returns it |
| MCP-SCOPE-03 | Create without a scope | Default scope appears in the response and storage |
| MCP-SCOPE-04 | Call search with a scope filter | Only that scope's keys are returned; no cross-scope leak |
| MCP-SCOPE-05 | Call search with a kind filter and a limit | Result is bounded by both; no duplicate or missing keys from the filtered set |
| MCP-SCOPE-06 | Search with unsafe punctuation | No JSON-RPC crash, no SQL error surfaced as a defect; empty or literal result |
| MCP-SCOPE-07 | Update/delete through MCP | Search results reflect the change immediately in the same server session |
| MCP-SCOPE-08 | Persist through one stdio process, restart, search through the next | Results and scope survive restart; migration/index state is on disk |
| MCP-SCOPE-09 | Oversized/empty scope or query | Declared tool error (`isError`) with an actionable message; server stays alive for the next call |

### HTTP API and web

| ID | Action | Expected |
| --- | --- | --- |
| API-SCOPE-01 | Create/list/get/update/delete with scope parameters | Status codes and error bodies match existing validation style; scope round-trips |
| API-SCOPE-02 | Search with scope/kind/pagination | JSON shape matches the agreed contract; bounds are enforced |
| API-SCOPE-03 | Cross-scope read attempt | 404/400 per contract, never the note body |
| WEB-SCOPE-01 | Switch scope in the UI | List and search update; editor saves to the selected scope |
| WEB-SCOPE-02 | Search from the UI | Results match API results for the same query; no stale entries after edit/delete |

## Turning this into tests

When the contract lands:

1. Add a fixture loader that inserts `corpus.json` through the agreed write
   operation (not raw SQL, except for migration fixtures), preserving ids and
   timestamps only if the contract allows caller-supplied ids; otherwise keep a
   key→generated-id map.
2. Add core acceptance tests for SCOPE-01..08, SEARCH-01..15, and
   SEARCH-DYN-01..02.
3. Extend `packages/mcp/src/acceptance.test.ts` with MCP-SCOPE-01..09, reusing
   its process-level NDJSON client.
4. Extend `packages/server/src/migration-compatibility.test.ts` with
   MIG-SCOPE-01..08, loading `legacy-v1.sql`.
5. Add API cases next to `packages/server/src/app.test.ts` and web cases next to
   `packages/web/src/main.test.ts`.
6. Do not weaken existing assertions about tool names, error messages, or the
   frozen legacy schema without an explicit contract decision.
