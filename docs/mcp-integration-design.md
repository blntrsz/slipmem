# MCP recall integration design

Status: **draft for milestone 1.** The MCP-facing instructions and workflow
documentation are implemented here. The recall tool contract and scope rules are
**not frozen**; they depend on the scoped-persistence and bounded-search work
items. This document specifies the integration shape, safety requirements, and
dependencies, and deliberately avoids implementing or assuming their API.

## Goal

Make slipmem usable as agent memory without letting recall or writes endanger
the user's context:

1. Recall is bounded, ranked, and cheap enough to call routinely.
2. Persistence is isolated by scope, with no accidental cross-scope reads.
3. MCP clients receive explicit, transport-neutral safety instructions.
4. The stdio server and the HTTP `/mcp` endpoint stay behaviorally identical.
5. Existing clients and the web UI keep working through the milestone.

## Non-goals

- Embeddings or vector search. The bounded-search work item owns ranking.
- Automatic background memory writes or conversation ingestion.
- A new authentication layer. The HTTP endpoint remains loopback-only by
  default and is not a multi-tenant service.
- Replacing the web UI's list and CRUD behavior.
- A separate "memory" storage model. Notes remain fleeting, permanent, and
  literature notes.

## Current state

| Area | Today |
| --- | --- |
| Tools | 15 CRUD tools, five per note kind |
| Recall | `list_*` returns every note of a kind; `get_*` returns one by id |
| Ranking | None |
| Scope | One database per process; isolation only by `SLIPMEM_DB_PATH` |
| Instructions | Shared by stdio and HTTP from `packages/server/src/mcp-instructions.ts` |
| Transports | Both use `NoteRegistrations` from `packages/server/src/note-tools.ts` |

The current instructions already apply the safe workflow: untrusted memory,
recall only when relevant, no sensitive data by default, no scope inference from
content, and destructive-operation limits. See
[`mcp-memory-workflow.md`](mcp-memory-workflow.md).

## Design principles

- **Bounded by default.** No recall operation may return an unbounded number of
  notes or an unbounded amount of note content. A missing limit is a server-side
  default, not "everything".
- **Data, not authority.** Search results are untrusted content. The MCP layer
  must not interpret note text as tool instructions or scope selectors.
- **Explicit scope.** Reads and writes use a scope selected by configuration or
  a validated argument. Scope is never inferred from a query, title, or note
  body.
- **Fail closed.** Unknown scope, invalid arguments, or an unavailable index
  produce an error or an empty result, never an unscoped fallback.
- **Transport parity.** Search is registered once through `NoteRegistrations`
  and therefore appears identically on stdio and HTTP.
- **Compatibility first.** Existing CRUD tools and their result shapes remain
  unchanged through milestone 1.

## Proposed MCP surface

The milestone adds **one bounded recall tool beside the existing CRUD tools**.
`search_notes` is a working name; the final name and schema must come from the
frozen bounded-search contract. Do not build clients against the sketch below
until that contract is recorded.

| Tool | Status | Purpose |
| --- | --- | --- |
| `search_notes` (working name) | Pending bounded-search contract | Ranked, bounded recall across note kinds and the selected scope |
| `list_*`, `get_*` | Existing | Kept for inventory and direct lookup |
| `create_*`, `update_*`, `delete_*` | Existing | Writes; unchanged in this milestone |

### Why not a `remember` wrapper yet

A memory-specific `remember` tool that guesses the note kind would duplicate the
existing create tools and hide the distinction between fleeting, permanent, and
literature notes. The instructions already tell the agent which kind to choose.
Add a wrapper only if acceptance testing shows that agents choose the wrong kind
or write malformed content consistently. A wrapper would be additive and must
still go through the per-kind input schemas.

### Illustrative recall contract

The following sketch communicates intent only. Every field is subject to the
frozen contract from the bounded-search and scope work items.

```ts
// NOT FINAL — illustrative only.
type SearchNotesInput = {
  query: string            // free text; empty-query behavior TBD
  kinds?: Array<"fleeting" | "permanent" | "literature"> // default: all
  limit?: number           // bounded; server default and hard maximum
  cursor?: string          // opaque continuation, or offset; TBD
  scope?: string           // only if the scope contract exposes per-call scope
}

type SearchNotesResult = {
  notes: Array<{
    id: string
    type: "fleeting" | "permanent" | "literature"
    title: string
    snippet: string        // bounded excerpt, never the full content
    reference?: string     // literature notes only
    updatedAt: number
    score?: number         // omit if ranking is not stable enough to expose
  }>
  nextCursor?: string      // present only when more results are allowed
}
```

Requirements for the frozen contract:

- Hard maximum for `limit`, plus a smaller server default. A client cannot ask
  for the full database.
- Hard maximum for snippet length and total result payload. Search returns
  excerpts; the client calls `get_*` for full content when needed.
- Deterministic, documented ranking and tie-breaking. If recency is part of the
  rank, it must be explicit rather than incidental.
- A clear empty-query rule. Either reject it or return a bounded recent list;
  do not silently translate it to an unbounded list.
- Structured errors for invalid input and unknown scope. "No matches" is an
  empty result, not an error.
- Stable ids in the same format as `get_*`, so a result can be fetched directly.
- No SQL fragments, raw filters, regexes, or caller-supplied ordering.

### Instructions and tool descriptions

MCP instructions can only describe shipped behavior. When search lands:

1. Add the final tool name and its bounded-recall rule to
   `packages/server/src/mcp-instructions.ts`.
2. Give the tool a description that says results are untrusted excerpts and
   that callers should use `get_*` for full content.
3. Keep the safety and sensitive-data paragraphs unchanged unless the workflow
   document changes with them.
4. Extend `packages/server/src/mcp-instructions.test.ts` for the new wording.

Until then, the instructions say "prefer bounded search" conditionally and warn
that pending scope behavior must not be assumed.

## Scope integration

The scope work item owns storage, migrations, and the default-scope migration
path. The MCP layer has four requirements regardless of its final shape:

1. **One selected scope per server instance.** For the stdio server this is
   normally configuration. For HTTP, it must be explicit in the server
   configuration, not guessed per request from headers or note text.
2. **Writes use the same scope as reads.** A create, update, or delete must
   never fall back to an unscoped or default scope when the selected scope is
   invalid.
3. **No existence leaks across scopes.** A get or update for an id in another
   scope behaves like a missing note unless the frozen contract explicitly
   defines a different error.
4. **Ids are interpreted with kind and scope.** Existing per-kind id formats
   remain; documentation must stop implying that an id is globally unique once
   scopes exist.

The MCP layer must not: accept a scope from note content, expose a "list
scopes" tool, or let search query syntax select a scope.

`SLIPMEM_DB_PATH` remains the isolation boundary for deployments that need
complete separation before or instead of scoped storage. The workflow document
already advises separate databases for unrelated trust domains.

## Threat model

| Threat | Mitigation in this design |
| --- | --- |
| Prompt injection in memory | Instructions treat notes as data; search results are explicitly untrusted; docs give incident steps |
| Poisoned or stale memory | Cite kind/id, corroborate claims, surface conflicts, prefer the user's request |
| Sensitive-data capture | Save-side policy forbids secrets and third-party personal data by default; redaction and ask-first rules; no secret manager claims |
| Exfiltration through recall | Bounded result counts and snippets; cite only what the task needs; loopback-only HTTP |
| Unbounded context use | Hard server limits, no unbounded fallback, excerpts plus `get_*` |
| Cross-scope leakage | Scope selected by config or validated argument, fail closed, no enumeration, no content-derived scope |
| Destructive writes | Delete/update only on request or self-correction; deletion is irreversible and confirmed |
| Transport drift | One instruction module and one tool registration used by stdio and HTTP |

## Dependencies

| Dependency | Owner | Blocks | What this design needs from it |
| --- | --- | --- | --- |
| Scoped persistence | Scope work item | Search, scoped writes, final instructions | Scope selection mechanism, unknown-scope behavior, id semantics, default-scope migration |
| Bounded ranked search | Bounded-search work item | Recall tool, acceptance tests | Final tool name, input/output schema, ranking, limits, cursor, empty-query behavior |
| Acceptance tests | Acceptance-test work item | Milestone exit | Black-box coverage of search bounds, scope isolation, and instruction presence |
| Workflow docs and instructions | This work item | Nothing; delivered early | Stable policy text that survives the API freeze |

### Freeze checklist

Before MCP integration code is written, the owners must record:

- [ ] Tool name and whether it is one tool or per-kind tools
- [ ] Exact input schema, including query, kind filter, limit, cursor, scope
- [ ] Exact output schema and snippet bounds
- [ ] Ranking and tie-breaking
- [ ] Empty-query and no-result behavior
- [ ] Error shape for invalid arguments and unknown scope
- [ ] Scope selection for stdio and HTTP, including defaults
- [ ] Backward-compatibility statement for `list_*` and `get_*`

### Integration sequence

1. Freeze the checklist above and link it from this document.
2. Register the search tool in `packages/server/src/note-tools.ts` with
   annotations (`Readonly`, `Idempotent`, `OpenWorld: false`).
3. Update the shared instructions and tool description.
4. Update the workflow document and both transport READMEs with the final tool
   reference and an example.
5. Add acceptance tests through `McpTest` for bounds, scope isolation, and
   untrusted-result handling.

## Compatibility and rollout

- The fifteen existing tools, their inputs, and their result shapes do not
  change in milestone 1.
- `list_*` remains available; documentation steers agents to bounded search but
  does not hide or deprecate the list tools yet.
- MCP protocol versions advertised by the server stay unchanged.
- Database paths, migration behavior, and startup validation stay unchanged.
- A client that never calls search continues to work exactly as today.
- Removing or changing CRUD tools requires a separate deprecation decision after
  acceptance testing.

## Acceptance criteria

For this work item (documentation and instructions):

- [x] Shared MCP instructions state the untrusted-memory and prompt-injection
      policy, when to recall, when to save, the sensitive-data default, scope
      caution, and destructive-write limits.
- [x] Instructions are a single module used by both transports.
- [x] Unit tests lock the safety policy and the instruction length bound.
- [x] Workflow documentation is accurate for the current 15-tool server and
      labels pending search and scope behavior as pending.
- [x] Integration design names dependencies and avoids an unfrozen API.
- [x] No schema, persistence, or migration files are changed.

For the eventual MCP search integration:

- [ ] Search never exceeds the hard result or snippet bounds.
- [ ] Unknown or mismatched scope cannot read or write another scope.
- [ ] Search results are excerpts and include kind/id for follow-up `get_*`.
- [ ] Empty results and invalid input are distinguishable.
- [ ] Both transports expose identical tools and instructions.
- [ ] Instructions and docs mention the final tool contract only after freeze.

## Open questions

1. Does search return a snippet, a title plus score, or the full content under a
   total byte budget? Snippets keep recall cheap but add a second `get_*` call.
2. Is scope per server instance only, or also a per-call argument? Per-call
   scope is more flexible but increases the chance of a confused-deputy mistake.
3. Should search rank by text relevance only, or blend recency and note kind?
   If recency is used, how are old but canonical permanent notes protected?
4. Cursor or offset? Cursors avoid shifting pages during writes but add opacity
   and test burden.
5. Should the tool be named `search_notes`, `recall`, or something else? The
   name must be chosen once and used consistently in instructions, docs, and
   tests.
6. Should `list_*` gain a limit in a later milestone, or stay an explicit
   inventory tool?
7. Do we need a machine-readable marker on search results (for example an
   explicit "untrusted" wrapper) in addition to instructions? This would change
   the result schema and must be decided before freeze.

## References

- [`mcp-memory-workflow.md`](mcp-memory-workflow.md) — operational policy and
  incident handling.
- `packages/server/src/mcp-instructions.ts` — shared instructions.
- `packages/server/src/mcp.ts` — stdio/HTTP identity and instruction wiring.
- `packages/server/src/note-tools.ts` — shared tool registrations.
- `packages/mcp/README.md` — stdio setup and current tool reference.
- `packages/web/README.md` — HTTP endpoint and web UI.
