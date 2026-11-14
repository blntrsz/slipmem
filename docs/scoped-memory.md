# Scoped memory contract

This document records the first milestone of the scoped-memory contract: the
scope namespace, its persistence and migration, and note provenance.

## Scope is a namespace, not authorization

Every note belongs to exactly one `scope`. A scope is an opaque namespace such
as `global`, `project:slipmem`, `agent:reviewer`, or
`project:slipmem/session:123`. It partitions storage and queries so unrelated
working sets do not mix.

The scope value is **not** an access-control decision. The server does not
derive permissions from it, and the database only enforces that a caller can
reach the rows it names by scope. An embedding application remains responsible
for deciding which namespaces a user or agent may ask for. This keeps the
storage contract usable by the local CLI, the web UI, and MCP clients without
pretending that a string in a request is an authenticated principal.

The grammar is intentionally small: 1–200 characters, starting with a letter or
digit, followed by letters, digits, `.`, `_`, `:`, `/`, or `-`. That supports
slash-style hierarchy and colon-style prefixes without introducing whitespace
or URL-hostile characters.

## Default scope and compatibility

`global` is the default scope. It is also the namespace assigned to every row
that existed before scopes were introduced.

- Callers that omit `scope` keep the pre-scope behavior: create, read, list,
  update, and delete operate on `global`.
- The first milestone does not move notes. An update uses the scope to locate a
  note; it cannot change the note's scope.
- Ids remain globally unique UUIDs, but an id alone is never enough to read,
  update, or delete a note. Every primary-key operation includes a scope
  predicate, and a cross-scope lookup behaves exactly like a missing note:
  `get` returns `None`, `update` returns not-found, and `delete` returns
  `false`.

## Provenance

Each note stores a provenance envelope:

```json
{ "source": "mcp", "actor": "review-agent", "externalId": "optional-source-id" }
```

- `source` is the writing surface (`api`, `mcp`, `import`, `legacy`, `unknown`,
  or an application-defined value).
- `actor` optionally identifies the user, agent, or session that authored it.
- `externalId` optionally points at a stable record in the source system.

Provenance is metadata, not a confidence score and not authorization. It is
written when a note is created and is immutable in this milestone. The built-in
surfaces apply `api` and `mcp` automatically; the persistence layer falls back
to `unknown` for direct service callers. Rows adopted from the pre-scope schema
receive `{"source":"legacy"}`.

The `Info` schemas decode rows without these fields as `global` and `legacy` so
older fixtures and clients remain readable. Write inputs keep both fields
optional for the same compatibility reason; the persistence layer resolves the
missing values.

## Persistence and migration

The three note tables gain:

```sql
scope TEXT NOT NULL DEFAULT 'global'
provenance TEXT NOT NULL DEFAULT '{"source":"legacy"}'
```

The generated migration uses `ALTER TABLE ... ADD ... DEFAULT ... NOT NULL`, so
SQLite can add the columns to populated tables in place. No rows are copied,
rewritten, or deleted. A scope/updated-at index is added for each note kind.

Startup validation is history-aware:

- No migration history: existing tables are validated against the frozen
  pre-scope bootstrap shape, missing tables are allowed, and the full history
  runs.
- Initial migration recorded but a later migration pending: all note tables
  must exist and match the initial shape. A missing or already-newer table is a
  `MigrationError` before any `ALTER` runs, instead of a raw SQL failure or a
  partial schema change.
- Latest migration recorded: all note tables must match the final shape.
- Unknown modern history is still refused before the initial migration can be
  appended to it.

The whole sequence runs in one `BEGIN IMMEDIATE` transaction, so two processes
starting against the same file serialize and a failed validation rolls back.

## Surfaces

- Core services accept an optional `scope` on every operation and always filter
  SQL by it.
- The aggregate `NoteService` applies the same scope predicate to each branch of
  its `UNION ALL`.
- The JSON API accepts `?scope=...` on list, get, create, update, and delete.
  It resolves a missing scope to `global` and rejects a malformed scope with
  `400`.
- MCP tools expose optional `scope` and `provenance` parameters and default
  created notes to the `mcp` source.
- The web UI continues to use `global`; a scope picker is out of scope for this
  milestone.

## Non-goals

- Authorization, tenancy, or sharing policy.
- Moving a note between scopes.
- Cross-scope search or aggregate reads.
- Provenance edits or an event ledger.
- Search ranking and filtering beyond the scope partition.
