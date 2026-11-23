# slipmem MVP plan: local Markdown memory for people and agents

Status: **proposed rewrite**. This document replaces the earlier SQLite-first
MVP assumptions. It keeps the prior product vision, but changes the source of
truth from an application database to a flat Markdown repository. No
implementation is implied until the phases below are accepted.

Date: 2026-11-17

Terminology update (2026-11-18): the canonical metadata field and every public
surface name is `tags`. The former `topics` name remains only as a read alias
for existing frontmatter and is rewritten as `tags` on the next save. This plan
and its examples use the current CLI, MCP, JSON API, web route, and wiki names.

Naming update (2026-11-19): new notes use `<kebab-slug>.md` filenames with a
`-2`, `-3`, ... collision suffix; creation time stays in frontmatter. Legacy
`YYYYMMDDHHmmss-<kebab-slug>.md` names remain valid and are not migrated.
Sections below that describe timestamp-prefixed filenames are retained as
historical design context. `README.md` and [`operator-guide.md`](operator-guide.md)
describe the current filename contract.

Related context:

- Current implementation: `@slipmem/schemas`, `@slipmem/core`,
  `@slipmem/mcp`, `@slipmem/server`, and the Foldkit app in `packages/web`.
- Existing MCP policy work on `mcp-memory-docs` (`docs/mcp-memory-workflow.md`).
- Existing scope work on `scope-contract` (`docs/scoped-memory.md`).
- Existing search and acceptance work on `bounded-ranked-search` and
  `workitem-c-acceptance-tests`.

Those branches are context, not dependencies. This plan must be implementable
on `main` without merging them first, and it must absorb their useful contracts
if they land.

## 1. Summary

slipmem is a local-first memory system for a person and the coding agents that
work with them. A plain Markdown repository under `.slipmem/` is the only
source of truth. The CLI, MCP server, and web app are three interfaces over that
repository. A disposable local index provides fast search but can be rebuilt at
any time.

The MVP makes five commitments:

1. **Files are the product.** Every note is one Markdown file in a flat
   `.slipmem/` directory. There are no type folders and no required service.
2. **Every note is portable.** Type, tags, timestamps, and provenance live in
   Markdown metadata, so the repository works with Git, an editor, a static
   site, or another tool.
3. **Agent writes are governed.** An agent may capture fleeting and literature
   notes directly, but only permanent note creation or changes require explicit
   human approval.
4. **Recall is bounded and cited.** Search and tag pages return a limited,
   inspectable set of notes with stable file citations.
5. **The local loop is complete.** `slipmem` can initialize a repository,
   capture and curate notes, serve MCP, and run the web UI on one machine with
   no external database or hosted account.

Tag pages are synthesized on demand. The MVP supports both extractive assembly
(selected notes quoted verbatim) and synthesized prose from a configurable model
or agent. Every mode passes through a citation validator, so each claim remains
traceable to a note file.

## 2. Vision

People accumulate decisions, sources, project facts, and half-formed ideas in
many places. Agents start every session without that context. Existing note
apps are often good at human browsing but poor at agent integration; agent
memory services are often opaque, hosted, or locked behind a database schema.

slipmem should be the smallest useful bridge:

- A user can read, edit, diff, back up, and version their memory with ordinary
  tools.
- An agent can recall relevant notes without pulling the entire repository into
  its context.
- An agent can propose durable knowledge, but a human decides what becomes
  permanent memory.
- A tag page is assembled from cited notes when it is needed, rather than
  maintained as a second, drifting source of truth.
- The same repository works locally through the CLI, MCP, and web UI, with no
  sync service required for the MVP.

The long-term collaboration story is Git: a repository can be cloned, branched,
reviewed, merged, and backed up like source code. A central server or CRDT sync
layer is a later option, not an MVP requirement. The MVP must not make that
future impossible: note identity, filenames, and metadata must remain stable
under a normal Git merge.

## 3. Goals and non-goals

### Goals

- Flat, human-readable Markdown storage under `.slipmem/`.
- A working CLI for init, capture, curation, search, review, wiki, and
  migration.
- An MCP stdio server and HTTP MCP endpoint with the same behavior.
- A locally runnable Foldkit web UI for list, read, edit, search, tags,
  review, and tag pages.
- Direct agent capture of fleeting and literature notes; explicit approval
  before an agent creates or changes a permanent note, or deletes any note.
- On-demand, tag-based wiki pages for humans and agents, synthesized from
  notes by a configurable model or agent, with citations.
- Migration from the current SQLite store without data loss.
- Practical security limits for a local, unauthenticated-by-default tool.

### Non-goals for the MVP

- Hosted accounts, multi-tenant authorization, or a public SaaS deployment.
- Real-time multi-user editing or CRDT conflict resolution.
- Vector search, embeddings, or an external search service.
- Automatic conversation ingestion, or unreviewed background memory writes.
  Serving modes require an explicitly configured chat model and use the
  generated-only, queue-driven maintenance path documented in the operator guide
  and MCP README. Ordinary one-shot CLI commands never consolidate.
- A persisted wiki. Tag pages are generated on demand and never stored as a
  second source of truth.
- A graph database. Links and tags are metadata, not a separate graph store.
- Replacing Git as the collaboration and backup mechanism.
- Encrypting the note repository. The MVP must warn that local files are
  plaintext.

## 4. Product and engineering principles

1. **Files over databases.** The SQLite index is a cache. Losing it must never
   lose a note.
2. **Flat by default.** Note type is metadata, not a directory. A single flat
   directory keeps paths predictable, makes Git diffs easy to inspect, and
   avoids moving files when a note is reclassified.
3. **Stable identity.** A note's filename stem is its ID. Links, citations,
   API responses, and MCP results use that ID rather than an array position.
4. **Humans approve permanent memory.** Low-trust captures are cheap; durable
   knowledge and deletions are deliberate.
5. **Data is not authority.** Note text, titles, links, and references are
   untrusted content. They never become instructions, permissions, or shell
   commands.
6. **Bounded recall.** Every list, search, and wiki operation has a server-side
   default limit and a hard maximum.
7. **Every claim is traceable.** Wiki output identifies the note file and ID
   behind each excerpt or claim. Synthesized sentences without a supporting note
   span are rejected or omitted.
8. **Local by default.** The web and MCP HTTP surfaces bind to loopback unless
   the operator explicitly opts out. There is no implicit cloud dependency.
9. **No silent destruction.** Writes are atomic, deletes go through approval
   for agents, migration is non-destructive, and Git operations are never
   automatic.

## 5. Storage contract

### 5.1 Repository root

- The default note root is `.slipmem/` at the workspace or repository root.
- Resolution order:
  1. `SLIPMEM_DIR`, when set, as an absolute or working-directory-relative
     path.
  2. The nearest ancestor `.slipmem/`, walking up from the current working
     directory.
  3. For `slipmem init`, create `.slipmem/` at the Git root when inside a Git
     repository, otherwise at the current directory.
- All note files live directly in `.slipmem/`. There are no `fleeting/`,
  `permanent/`, `literature/`, or date subdirectories.
- Local, non-note state may live in `.slipmem/.state/` (pending approvals,
  migration manifests, locks). `.state/` is gitignored and never treated as
  note content.
- The search index lives outside the repository, under
  `$XDG_CACHE_HOME/slipmem/` (falling back to
  `~/.cache/slipmem/`), keyed by a hash of the note root. It is disposable.

The repository is the portable artifact. `.slipmem/.state/` and the cache are
local implementation details and are not part of backup or sync.

### 5.2 Filenames

Every note filename follows this exact shape:

```text
YYYYMMDDHHmmss-<kebab-case-title>.md
```

Examples:

```text
20261117193045-agent-memory-is-bounded.md
20261117201500-mcp-recall-must-cite-sources.md
```

Rules:

- The prefix is the note's creation time in **UTC**, to the second, with no
  separators. It is the leading identity signal and is parsed as the canonical
  creation time.
- The title segment is a lowercase ASCII kebab-case slug:
  - Unicode is normalized, diacritics are removed where practical, and
    characters outside `a-z`, `0-9`, and `-` are replaced.
  - Runs of separators collapse to one `-`; leading and trailing `-` are
    removed.
  - The slug is truncated to 80 characters on a word boundary where possible.
  - An empty slug becomes `untitled`.
- The accepted filename pattern is
  `^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$`.
- If two notes would receive the same filename, the second gets `-2`, then
  `-3`, and so on, after the slug. The 14-digit prefix is never changed.
- Only files matching the pattern are notes. Other files in `.slipmem/` are
  reported by `slipmem check` and ignored by the index, except for `.state/`.
- Symlinks are not followed for note files. A note path must resolve inside the
  note root.

The filename stem is the note ID. For example, the ID of
`20261117193045-agent-memory-is-bounded.md` is
`20261117193045-agent-memory-is-bounded`.

**Title changes do not rename a note in the MVP.** The `title` field is
authoritative for display; the slug records the title at creation time. This
avoids silently breaking wikilinks, Git history, and external citations. A
separate opt-in `slipmem rename <id>` can be added later with link rewriting and
aliases. `slipmem check` may warn about slug drift, but it must not rename
anything automatically.

### 5.3 Markdown metadata

Each note is YAML frontmatter followed by a Markdown body. YAML is chosen
because it is the common convention in Markdown tooling and supports arrays and
nested provenance without inventing a custom parser.

```markdown
---
schema: 1
id: 20261117193045-agent-memory-is-bounded
type: permanent
title: Agent memory is bounded
createdAt: "2026-11-17T19:30:45Z"
updatedAt: "2026-11-17T19:35:02Z"
tags:
  - agent-memory
  - retrieval
provenance:
  source: cli
  actor: user
---

Search results must have a hard server-side limit. A caller cannot request the
entire repository by omitting a limit.
```

Required fields:

| Field | Rule |
| --- | --- |
| `schema` | Integer. `1` for this contract. |
| `id` | Must equal the filename stem. |
| `type` | One of `fleeting`, `permanent`, `literature`. |
| `title` | Non-whitespace string. Display title; not the path. |
| `createdAt` | ISO 8601 UTC timestamp with seconds. Must agree with the filename prefix. |
| `updatedAt` | ISO 8601 UTC timestamp with seconds, at least `createdAt`. |
| `tags` | Optional array of lowercase kebab-case tag slugs. |

Type-specific fields:

| Type | Additional requirement |
| --- | --- |
| `fleeting` | Body must be non-whitespace. Maximum 1000 characters. |
| `permanent` | Body must be non-whitespace. Maximum 2000 characters. |
| `literature` | Body must be non-whitespace. Maximum 5000 characters. `reference` is required and must be non-whitespace. |

Optional fields:

| Field | Purpose |
| --- | --- |
| `reference` | Source URL, citation, or stable source identifier. Required for literature notes. |
| `provenance.source` | One of `cli`, `web`, `mcp`, `import`, `legacy`, or an application-defined value. |
| `provenance.actor` | Optional user, agent, or session identifier. |
| `legacyId` | Original SQLite id or external id, used by migration and deduplication. |
| `aliases` | Optional previous IDs or titles. Reserved for future rename support. |

Rules for readers and writers:

- Unknown frontmatter keys are preserved on read and write so manual metadata
  and future fields are not destroyed.
- Invalid known fields fail validation with the file path and field name.
- The body is the note content. The title is not duplicated as an H1 by
  default; templates may add one, but it is not structural.
- Frontmatter must be plain YAML, not an executable template. No YAML tags,
  custom constructors, or includes are allowed.
- New writes always produce the full required metadata. Reads may accept older
  files only through an explicit compatibility path with a warning.

### 5.4 Note types and lifecycle

Type is metadata and never changes implicitly.

- **Fleeting** notes are an inbox for quick captures. They may be incomplete or
  contradictory. An agent can create and update them directly.
- **Permanent** notes are distilled, self-contained knowledge. Only a human
  action or an approved proposal can create or update them.
- **Literature** notes are source-backed notes tied to a source. They require
  `reference` and, like fleeting notes, may be created and updated directly by
  an agent.
- Reclassifying a note changes the `type` field only. The filename and path stay
  the same. An agent may reclassify directly unless the change creates, alters,
  or removes a permanent note; those changes require approval.
- Deleting a note removes one file. Moves go to the operating system trash or a
  dated backup outside `.slipmem/`; the implementation must not implement an
  irreversible in-place shred by default.

### 5.5 Derived index

- Use a local SQLite database with FTS5 for ranked full-text search.
- Store only derived fields needed for search and listing: path, ID, type,
  title, tags, reference, body text, timestamps, and content hash.
- Refresh entries when a file's mtime or size changes, and rebuild entirely
  when the schema version or note root changes.
- On any inconsistency, rebuild from files. The index never repairs a note and
  never becomes the source of truth.
- The index is per-user and per-root. It may contain note text, so create it
  with user-only permissions.
- `slipmem check --rebuild-index` is the documented recovery path.
- If FTS5 is unavailable in a supported runtime, fall back to a bounded linear
  scan for the MVP and report the degraded mode. Do not fail note access.

### 5.6 Links, tags, and Git

- Internal links use Markdown links to note files or `[[filename-stem]]`
  wikilinks. The index records backlinks as derived data.
- `tags` live in frontmatter. A tag is not a folder. Tag listings are
  derived from metadata and optional title/body matching.
- Notes are ordinary Git-tracked files. The CLI and web app must not run
  `git commit`, `git push`, `git reset`, or history-rewriting commands
  automatically.
- A normal Git merge may produce conflict markers in a note. `slipmem check`
  must detect conflict markers and report them; it must not "resolve" them.
- Concurrent writers in one process are serialized with a repository-level
  lock. Cross-process writers rely on atomic rename and last-writer-wins at the
  file level; the MVP does not promise CRDT merging.

## 6. Architecture

### 6.1 Components

| Layer | MVP responsibility |
| --- | --- |
| `@slipmem/schemas` | Note types, metadata schema, create/update/search/wiki inputs, validation errors, filename pattern, approval proposal schema. |
| `@slipmem/core` | Markdown repository, frontmatter parser, slug and filename generation, atomic write, validation, locking, migration importer, derived index, note and wiki services. |
| `@slipmem/cli` (new) | Local user commands, editor integration, review and approval queue, migration entry point. |
| `@slipmem/server` | HTTP JSON API and shared MCP registrations over the core services. |
| `@slipmem/mcp` | stdio transport and MCP-specific instructions. |
| `@slipmem/web` | Foldkit UI served by the local server; no separate API process. |
| Derived cache | SQLite FTS index and optional backlink tables outside the note root. |

### 6.2 Data flow

```text
Markdown files in .slipmem/
        |
        v
MarkdownNoteRepository (parse, validate, write)
        |
        +--> NoteService (CRUD, list, get, search)
        +--> WikiService (tag selection, synthesis, citations)
        +--> MigrationService (SQLite -> Markdown)
        |
        v
CLI        MCP stdio / HTTP        Web UI / JSON API
```

The core must expose one repository interface consumed by all surfaces. The
stdio MCP server and HTTP MCP endpoint must register the same tool
implementations, as they do today.

### 6.3 What carries forward

- The Effect service style and typed failures in `@slipmem/core`.
- The per-kind content limits and literature `reference` requirement.
- The note union and `type` discriminant in `@slipmem/schemas`.
- Shared MCP registrations between stdio and HTTP.
- Foldkit SSR and the single-process web server.
- The loopback-by-default HTTP posture.
- Existing tests as migration and behavior references.

### 6.4 What is replaced

- SQLite note tables as the source of truth.
- `SLIPMEM_DB_PATH` as the normal configuration knob. It remains only for the
  migration importer and a short compatibility window.
- Type-specific storage paths and type-specific identity assumptions.
- Drizzle migrations for note content. The derived index gets its own
  disposable schema and no migration promises.

## 7. Interfaces

### 7.1 CLI

Add `packages/cli` with a single `slipmem` executable. The CLI is the reference
human interface and must work without the web server or MCP.

| Command | Behavior |
| --- | --- |
| `slipmem init` | Create `.slipmem/`, local state, and a starter README. Idempotent. |
| `slipmem new --type <type> --title <title>` | Create a note. Content comes from `--content`, stdin, or `$EDITOR`. Validates type rules. |
| `slipmem list [--type <type>] [--tag <tag>] [--limit <n>]` | Bounded list with IDs, types, titles, and updated times. |
| `slipmem show <id>` | Print one note, including metadata and file path. |
| `slipmem edit <id>` | Open `$EDITOR`, validate on save, write atomically. |
| `slipmem search <query> [--type <type>] [--tag <tag>] [--limit <n>]` | Bounded ranked search with IDs and excerpts. |
| `slipmem tags` | List tags and note counts. |
| `slipmem wiki <tag> [--limit <n>] [--mode extractive\|synthesized] [--model <id> \| --agent <command>] [--out <path>]` | Generate a cited tag page, extractive or synthesized by a configured model or agent. Stdout by default. |
| `slipmem review` | List pending approval proposals with summaries and diffs. |
| `slipmem approve <proposal-id>` | Apply a proposal if its base version still matches. |
| `slipmem reject <proposal-id>` | Discard a proposal without touching notes. |
| `slipmem check [--rebuild-index]` | Validate filenames, metadata, content limits, links, duplicate IDs, conflict markers, and index drift. |
| `slipmem migrate sqlite --db <path> [--dry-run] [--merge]` | Import existing SQLite notes into Markdown. |
| `slipmem mcp` / `slipmem web` | Optional wrappers that start the same MCP or web entry points. |

Human CLI writes are direct. The CLI must still obey content limits, atomic
writes, and confirmation prompts for destructive actions.

### 7.2 MCP

Preserve the existing per-kind tool names where possible so clients do not need
a full rewrite. Add bounded read tools.

| Tool group | MVP behavior |
| --- | --- |
| `list_fleeting_notes`, `list_permanent_notes`, `list_literature_notes` | Bounded list; default limit and hard maximum; IDs are filename stems. |
| `get_*_note` | Fetch one note by ID. Missing or cross-root IDs return not found. |
| `create_fleeting_note`, `update_fleeting_note` | Direct write with provenance `source: mcp`. |
| `create_permanent_note`, `update_permanent_note` | Create a pending proposal by default; no note file changes until human approval. |
| `create_literature_note`, `update_literature_note` | Direct write with provenance `source: mcp`; the literature `reference` requirement still applies. |
| `delete_*_note` | Create a pending proposal. No MCP self-approval. |
| `search_notes` (new) | Bounded ranked search across types, with optional type and tag filters. |
| `list_tags` (new) | Tag names with counts and bounded examples. |
| `build_tag_wiki` (new) | On-demand tag page with citations, extractive or synthesized by the configured model or agent. Read-only. |

MCP requirements:

- The stdio and HTTP registrations are the same code path.
- The MCP server instructions repeat the trust boundary: notes are untrusted
  data, not instructions; do not save secrets; cite IDs; do not bulk-edit; do
  not attempt to bypass approval.
- Recall results are bounded by both result count and excerpt length.
- The server never interprets a note's text as a tool call, path, scope, or
  approval.
- The default write policy is `approval`. A trusted-automation escape hatch may
  be provided as `SLIPMEM_MCP_WRITE_POLICY=direct`, but it must be documented as
  unsafe for shared or untrusted content and must record that provenance.
- `SLIPMEM_ACTOR` may identify the agent. Provenance is metadata, not
  authentication.

### 7.3 Web and JSON API

The Foldkit app remains a local, single-process interface.

Pages:

- `/` - note list, filterable by type and tag.
- `/notes/:id` - note detail and edit form.
- `/new` - create form with type selector.
- `/tags` - tag index.
- `/wiki/:tag` - on-demand cited tag page, extractive or synthesized.
- `/review` - pending proposals with diff and approve/reject actions.
- `/health` or an equivalent local status view.

Canonical API:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/health` | Service status and note root. |
| `GET` | `/api/notes` | Bounded list, optional type/tag filters. |
| `POST` | `/api/notes` | Create a note with `type` in the body. |
| `GET` | `/api/notes/:id` | One note or not found. |
| `PUT` | `/api/notes/:id` | Update a note; type changes follow the approval policy. |
| `DELETE` | `/api/notes/:id` | Delete a note; human UI action. |
| `GET` | `/api/search?q=...` | Bounded ranked search. |
| `GET` | `/api/tags` | Tag inventory. |
| `GET` | `/api/wiki/:tag` | Cited tag page as Markdown or structured sections; `mode` selects extractive or synthesized. |
| `GET` | `/api/pending` | Pending proposals. |
| `POST` | `/api/pending/:proposalId/approve` | Apply an approval. |
| `POST` | `/api/pending/:proposalId/reject` | Reject an approval. |

Compatibility:

- Keep the old `/api/notes/:type` and `/api/notes/:type/:id` routes as thin
  adapters for one release after the Markdown cutover. They must resolve
  through the same ID-based repository and must not introduce type folders.
- The web UI should switch to ID-based routes in the same phase. Keep a
  redirect or adapter for bookmarked type routes if inexpensive.

## 8. Approval for agent writes

Approval is a product requirement, not only a prompt instruction. The server
must enforce it.

### 8.1 Policy matrix

| Actor and action | Default |
| --- | --- |
| Human via CLI or web, any create/update/delete | Direct, with normal validation and confirmation for delete. |
| Agent via MCP, create or update fleeting | Direct. Fleeting is a low-trust inbox. |
| Agent via MCP, create or update permanent | Pending human approval. |
| Agent via MCP, create or update literature | Direct; the `reference` requirement applies. |
| Agent via MCP, delete any note | Pending human approval. |
| Agent via MCP, reclassify to or from permanent | Pending human approval. |

The default is deliberately conservative. If experience shows that fleeting
updates need approval too, tighten the matrix without changing the mechanism.

### 8.2 Proposal lifecycle

1. The MCP tool validates its input and reads the current target note, if any.
2. The server writes a proposal record under `.slipmem/.state/pending/`. A
   proposal contains:
   - proposal ID, creation time, expiry
   - operation (`create`, `update`, `delete`, `reclassify`)
   - target note ID and path
   - base content hash for updates and deletes
   - the proposed full file content or deletion target
   - actor, source `mcp`, and a human-readable summary
3. The tool returns `{ "status": "pending_approval", "proposalId": ..., "summary": ... }`.
   It must not pretend the note was written.
4. A human runs `slipmem review`, inspects the diff, and approves or rejects.
5. Approval revalidates the base hash and all note rules. If the note changed
   since the proposal, approval fails without writing; the agent must propose
   again from the new state.
6. Applying a proposal writes a temporary file in the same directory and
   renames it into place. It then refreshes the index and removes the proposal.
7. Proposals expire after a bounded period (initially 7 days) and are cleaned up
   by `slipmem review` or `slipmem check`.
8. Approval and rejection are available only through local human interfaces.
   They are not MCP tools, so an agent cannot approve its own write.

Approval records are local state, not notes. They must never appear in the note
index or in `.slipmem/*.md`.

## 9. Tag-based, on-demand cited wiki

### 9.1 Behavior

`slipmem wiki <tag>` and `build_tag_wiki` assemble a page only when asked.
They do not write a permanent wiki into the note repository.

Selection:

1. Normalize the requested tag to a slug.
2. Prefer notes whose `tags` include the slug.
3. Add bounded matches from title, body, and literature reference, with exact
   tag matches ranked first.
4. Use permanent and literature notes by default. Exclude fleeting notes unless
   `--include-fleeting` is explicit.
5. Apply a default limit of 10 notes and a hard maximum of 25.
6. If no notes match, return an empty result with tag suggestions. Do not
   invent content.

### 9.2 Output contract

The page may be generated in either mode, selected by configuration:

- **Extractive.** Each excerpt is quoted or tightly paraphrased from one note
  and carries a citation to that note's ID and file. No prose is invented.
- **Synthesized.** A configurable model or agent composes prose from the
  selected notes. The synthesizer receives only the bounded, selected note set
  and never gets tools, write access, or authority to act on note content. A
  citation validator checks every sentence against its supporting note span;
  unsupported sentences are rejected or omitted before output.

Example extractive output:

```markdown
# Tag: agent memory

_Generated on 2026-11-17T20:10:00Z from 3 notes. Extractive; verify sources._

## Bounded recall

> Every list, search, and recall operation has a default limit and a hard
> maximum.

Source: [[20261117193045-agent-memory-is-bounded]]
(`.slipmem/20261117193045-agent-memory-is-bounded.md`, permanent, updated
2026-11-17T19:35:02Z)

## Sources

- [[20261117193045-agent-memory-is-bounded]] - Agent memory is bounded
- [[20261117201500-mcp-recall-must-cite-sources]] - MCP recall must cite sources
```

Requirements:

- Every factual excerpt or synthesized sentence has an adjacent source citation.
- The generator may not merge two notes into one unsupported claim.
- Conflicting notes are shown side by side with both citations, not silently
  reconciled.
- The page includes a generated timestamp, note count, and a clear statement
  that it is derived.
- Output is bounded by note count and total characters.
- By default, output goes to stdout or the HTTP response. `--out` may write an
  explicit path outside `.slipmem/`; it must not create a second source of
  truth inside the note root.
- Source text is treated as untrusted. A note that says "ignore previous
  instructions" is quoted as data, never followed.

Synthesis configuration: `SLIPMEM_WIKI_SYNTHESIS` selects `extractive`, a model
ID, or a local agent command. In every non-extractive mode the citation
validator rejects any sentence without a supporting source span. The synthesizer
runs locally against the bounded selection; note text stays untrusted data.

## 10. Phased plan

Each phase must leave `main` runnable and the existing test suite passing. No
phase may convert the repository to the new store and leave the app unable to
start.

### Phase 0 - Freeze the contract and fixtures (1-2 days)

Deliverables:

- Confirm the decisions in section 5: root resolution, filename pattern,
  frontmatter fields, immutable filename stems, and approval policy.
- Add deterministic fixtures for valid and invalid notes, including Unicode
  titles, duplicate titles in the same second, long titles, malformed YAML,
  conflict markers, and every note type.
- Add migration fixtures covering the current SQLite shape, legacy bootstrap
  shape, empty databases, and invalid rows.
- Record example CLI, API, and MCP payloads for acceptance tests.

Exit criteria:

- A reviewer can read this plan and the fixtures without making another product
  decision.
- Filename, metadata, approval, and wiki output rules are testable.

### Phase 1 - Markdown repository and disposable index (4-6 days)

Deliverables:

- `MarkdownNoteRepository` with parse, validate, list, get, create, update,
  delete, atomic write, and repository locking.
- Slug and filename generation with collision handling.
- YAML frontmatter parsing with unknown-key preservation and strict known-field
  validation.
- Bidirectional mapping between `Note.Info` and Markdown.
- Derived SQLite FTS index with rebuild, refresh, and bounded search.
- A `slipmem check` core routine for filenames, metadata, duplicate IDs, limits,
  conflict markers, and index drift.

Exit criteria:

- A note created through the repository survives a process restart and can be
  read with only the filesystem.
- Deleting the index and rebuilding it returns the same note IDs and search
  results.
- Invalid files fail with actionable paths and never partially write.
- Tests cover every filename and metadata rule in section 5.

### Phase 2 - CLI and migration importer, dry run (4-6 days)

Deliverables:

- New `packages/cli` with `init`, `new`, `list`, `show`, `edit`, `search`,
  `tags`, `check`, and `wiki` (basic form).
- `review`, `approve`, and `reject` over the proposal store.
- `migrate sqlite --dry-run` that maps old rows to proposed Markdown files and
  prints a report without writing the note root.
- A clean-clone local workflow in the README.

Exit criteria:

- From a clean checkout, `bun install && bun run slipmem -- init` followed by
  `new`, `list`, and `search` works offline.
- Every CLI write is atomic and validated.
- Dry-run migration on a real database reports counts and conflicts without
  modifying the source database or target notes.

### Phase 3 - MCP parity and enforced approvals (4-6 days)

Deliverables:

- MCP read and write tools backed by the same repository.
- Pending proposals for permanent, reclassification, and delete operations;
  direct fleeting and literature writes.
- MCP instructions updated for Markdown storage, citations, bounded recall, and
  approval.
- Shared registrations between stdio and HTTP MCP.
- Provenance written for CLI, web, MCP, and migration writes.

Exit criteria:

- An MCP client cannot create a permanent note without a human approval.
- An MCP client can create and update literature notes directly when they carry
  a valid reference.
- A stale proposal cannot overwrite a changed note.
- Fleeting capture works directly.
- stdio and HTTP return the same shapes and enforce the same limits.
- Approval cannot be triggered through MCP.

### Phase 4 - Web UI, tag pages, and review queue (5-7 days)

Deliverables:

- Foldkit list, detail, create, edit, delete, search, tags, and wiki views.
- `/review` page for proposals with an inspectable diff.
- Canonical ID-based JSON API and compatibility adapters for old type routes.
- Loopback default and explicit warning for non-loopback binds.
- On-demand wiki rendering with citations and no persisted duplicate.

Exit criteria:

- A user can complete the full local loop in the browser: create, recall,
  search, propose-to-review (using MCP), approve, and open a tag page.
- The UI never stores notes in browser-only state as the source of truth.
- The web and MCP surfaces see the same files immediately after writes.

### Phase 5 - Real migration and cutover (3-5 days)

Deliverables:

- Full `migrate sqlite` implementation from the current default database path
  and `SLIPMEM_DB_PATH`.
- Field mapping for type, title, body, reference, timestamps, scope, provenance,
  and legacy IDs.
- Dry-run and merge modes, manifest output, and a pre-migration backup.
- Cutover of default paths and documentation from SQLite to `.slipmem/`.
- A read-only compatibility path for the old database for one release.

Exit criteria:

- All rows from a representative database become valid notes with no content
  loss.
- Re-running the import is idempotent, or safely refuses without duplicates.
- The old SQLite file remains untouched and usable for rollback.
- The application starts with Markdown only and no Drizzle note migrations.

### Phase 6 - Hardening, documentation, and release (3-5 days)

Deliverables:

- Security limits from section 12 enforced and tested.
- `bun run check` extended with CLI, migration, and approval tests.
- README and package READMEs updated: Markdown is the source of truth; SQLite
  is only a cache or migration source.
- A short operator guide for local MCP configuration, backups, and recovery.
- Removal or deprecation notes for legacy type routes and SQLite settings.

Exit criteria:

- Overall acceptance criteria in section 13 pass.
- A fresh clone, a migrated clone, and a repository with only `.slipmem/` notes
  all start the CLI, MCP, and web app successfully.
- No documentation claims SQLite is the source of truth after cutover.

## 11. Migration from the current SQLite store

The current implementation stores notes in three tables (`fleeting_note`,
`permanent_note`, `literature_note`) in
`$XDG_DATA_HOME/slipmem/slipmem.db` or `SLIPMEM_DB_PATH`. Some databases were
created by an older handwritten bootstrap and later adopted by Drizzle. The
migration must handle both shapes and must not assume the source database is
healthy.

### 11.1 Field mapping

| SQLite field | Markdown field |
| --- | --- |
| `id` | `legacyId` (preserved for traceability) |
| table kind | `type` (`fleeting`, `permanent`, `literature`) |
| `title` | `title` and creation-time slug |
| `content` | Markdown body |
| `reference` | `reference` (literature only) |
| `created_at` | filename UTC prefix and `createdAt` |
| `updated_at` | `updatedAt` |
| `scope`, if present | frontmatter `scope` compatibility field or future scoped-memory contract |
| provenance columns, if present | frontmatter `provenance` |

Timestamps are stored as finite milliseconds today. Convert them to whole
seconds in UTC for the filename and ISO timestamps. If two rows round to the
same second, keep distinct files with the collision suffix.

### 11.2 Safety rules

- **Dry run first.** Print the proposed file count, per-type counts, filename
  collisions, invalid rows, and a sample mapping. Do not write in dry-run mode.
- **Do not delete or modify the source database.** Open it read-only where
  possible and copy it to a timestamped backup before any non-dry-run import.
- **Refuse to pollute a non-empty note root** unless `--merge` is explicit.
- **Idempotency.** In merge mode, detect existing notes by `legacyId` and skip
  or report them instead of duplicating.
- **No silent data loss.** Rows that fail validation are written to a report and
  either imported with a warning or quarantined for manual review. The default
  is to preserve the text and report the problem, never to truncate it.
- **Manifest.** Write a local migration manifest with source ids, target paths,
  hashes, warnings, and counts. Keep it in `.state/`, not in the note root.
- **Verification.** After writing, re-read every target file through the parser,
  compare counts and content hashes, and fail the command if verification does
  not match the dry-run plan.
- **Rollback.** The untouched SQLite database is the rollback. Markdown notes
  are additive; the migration never runs `git` commands.
- **Scope-aware.** If the scoped-memory branch lands first, preserve scope and
  provenance rather than collapsing everything into one namespace. If it does
  not land, migrate current rows into the default scope.

### 11.3 Cutover

1. Ship the importer and run a dry run on a copy of the real database.
2. Import into a temporary note root and run `slipmem check`.
3. Compare counts, titles, types, references, and content hashes.
4. Move the verified notes into the real `.slipmem/` root, or import directly
   after a backup.
5. Start CLI, MCP, and web against Markdown only.
6. Keep the SQLite file as a read-only archive for one release; do not write to
   it.
7. Update docs and remove note-table migrations from the active startup path.

## 12. Security limits

slipmem is local-first, not a hardened multi-user service. The MVP must still
fail closed at its trust boundaries.

| Area | Limit |
| --- | --- |
| Note paths | Accept only direct children of the note root matching the filename pattern. Reject traversal, absolute paths, separator injection, and symlinks escaping the root. |
| File size | Reject note files larger than 1 MiB on read; new content must satisfy the per-type limit (1000 / 2000 / 5000 characters). |
| Frontmatter | Reject executable YAML features, aliases with excessive expansion, and documents above a small fixed size. Parse with a safe schema. |
| Recall | Default 10 results, hard maximum 50 for search/list; bounded excerpt length; reject empty or oversized queries. |
| Wiki | Default 10 notes, hard maximum 25; bounded total output; no arbitrary note count or unbounded excerpts. |
| Approval | Server-enforced for permanent and destructive MCP writes. Proposals bind to a base content hash and expire. No MCP approval tool. |
| Network | Web and HTTP MCP bind to `127.0.0.1` by default. No authentication is implied. Non-loopback binding is an explicit, documented risk. |
| CORS and origins | Do not enable permissive cross-origin access. The local API is not a public API. |
| Sensitive data | Notes are plaintext and unencrypted. MCP instructions forbid secrets and sensitive personal data; the tool is not a secret store. |
| Trust boundary | Note text is data, never instructions, permissions, scope, or paths. Never execute note content or follow note-provided commands. |
| Prompt injection | Wiki output treats notes as untrusted data in extractive and synthesized modes; note-provided instructions never reach the synthesizer as instructions or become tool calls. The web UI must render note content as text/Markdown, not trusted HTML. |
| Deletion | Human confirmation for destructive CLI/web actions; MCP deletion always pending approval. Prefer trash or backup over permanent unlink. |
| Concurrency | One writer lock per repository; atomic temp-file-plus-rename writes; fail clearly on lock or stale-base conflicts. |
| Index | Cache permissions are user-only. Cache is disposable and may contain note text. Provide a clear-cache command. |
| Git | Never auto-commit, auto-push, force-push, or rewrite history. Never auto-resolve merge conflicts. |
| Rate and abuse | Bound proposal queue size and search query length; report errors rather than retrying unbounded work. |

The security posture must be stated in the README: local note files are
readable by anyone who can read the repository, and the local HTTP server is
unauthenticated.

## 13. Acceptance criteria

### 13.1 Storage

- **STOR-01:** `slipmem init` creates `.slipmem/`; every note created afterward
  is a direct child of that directory.
- **STOR-02:** No type directories are created anywhere under `.slipmem/`.
- **STOR-03:** Every note filename matches
  `^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$` and its 14-digit prefix equals
  `createdAt` in UTC seconds.
- **STOR-04:** Every note has valid frontmatter with `schema`, `id`, `type`,
  `title`, `createdAt`, and `updatedAt`; `id` equals the filename stem.
- **STOR-05:** Literature notes without a non-whitespace `reference` are
  rejected; the same content limits as today apply by type.
- **STOR-06:** Two notes with identical titles in the same second receive
  distinct filenames without changing the timestamp prefix.
- **STOR-07:** Unknown frontmatter keys survive a read/write round trip.
- **STOR-08:** A malformed note fails with its path and field; no partial file is
  written.

### 13.2 Source of truth and recovery

- **TRUTH-01:** Deleting the derived index and running a rebuild produces the
  same IDs, list results, and searchable content.
- **TRUTH-02:** Copying only `.slipmem/*.md` to a fresh directory is enough to
  start the CLI, MCP, and web surfaces.
- **TRUTH-03:** A note edited by an external editor is visible after an index
  refresh without importing or migrating.
- **TRUTH-04:** No runtime path requires SQLite note tables after cutover.

### 13.3 CLI, MCP, and web parity

- **SURFACE-01:** A note created by the CLI is immediately readable by MCP and
  the web app from the same root.
- **SURFACE-02:** stdio and HTTP MCP expose the same tool names, input schemas,
  limits, and result shapes.
- **SURFACE-03:** Web list, search, and tag views show notes from all three
  types without type folders.
- **SURFACE-04:** The web API uses stable note IDs and does not rely on array
  positions or SQLite ids.
- **SURFACE-05:** Type route compatibility, if present, resolves through the
  same repository and creates no new storage layout.

### 13.4 Approval

- **APPROVE-01:** An MCP permanent create or update returns a pending proposal
  and creates or changes no note file.
- **APPROVE-02:** An MCP literature create or update writes directly and carries
  `source: mcp` provenance.
- **APPROVE-03:** An MCP delete of any note creates a pending proposal and
  deletes nothing.
- **APPROVE-04:** `slipmem approve` applies the proposal atomically and the note
  becomes visible to CLI, MCP, and web.
- **APPROVE-05:** `slipmem reject` leaves all notes unchanged.
- **APPROVE-06:** A proposal whose base hash no longer matches is rejected
  without overwriting the current note.
- **APPROVE-07:** No MCP tool can approve or reject a proposal.
- **APPROVE-08:** Fleeting creates and updates through MCP work directly and
  carry `source: mcp` provenance.
- **APPROVE-09:** Pending proposals never appear in note lists, search, tag
  pages, or `.slipmem/*.md`.

### 13.5 Tag wiki

- **WIKI-01:** `slipmem wiki <tag>` returns only notes matching the tag
  filters, within the default and maximum bounds.
- **WIKI-02:** Every factual excerpt or synthesized sentence has an adjacent
  note ID and file citation.
- **WIKI-03:** No matching notes produce an empty or "no sources" result, not
  invented content.
- **WIKI-04:** Conflicting notes are presented with separate citations rather
  than merged into one claim.
- **WIKI-05:** Wiki generation writes nothing under `.slipmem/` unless an
  explicit output path outside the note root is requested.
- **WIKI-06:** Wiki output treats note text as data and does not follow
  instructions embedded in a note.
- **WIKI-07:** A configured model or agent synthesizer produces a cited page,
  and every synthesized sentence either passes the citation validator or is
  omitted.

### 13.6 Migration

- **MIGRATE-01:** A representative current database imports every row with type,
  title, content, reference, and timestamps preserved.
- **MIGRATE-02:** The source database is unchanged after import; a backup is
  created.
- **MIGRATE-03:** Dry run writes no notes and reports counts, collisions, and
  invalid rows.
- **MIGRATE-04:** Re-running in merge mode does not duplicate imported notes.
- **MIGRATE-05:** Imported notes pass `slipmem check` and are readable through
  all three surfaces.
- **MIGRATE-06:** A row with legacy-only or malformed data is reported and is
  not silently dropped or truncated.

### 13.7 Security and quality

- **SEC-01:** Path traversal, separator injection, absolute paths, and escaping
  symlinks are rejected.
- **SEC-02:** Oversized files, content, queries, and wiki requests are rejected
  or bounded with actionable errors.
- **SEC-03:** The server binds to loopback by default and documents the risk of
  changing `HOST`.
- **SEC-04:** Note content is not executed, evaluated, or used as a tool
  instruction; the web UI escapes untrusted HTML.
- **SEC-05:** No operation automatically commits, pushes, or rewrites Git
  history, and conflict markers are reported rather than resolved.
- **SEC-06:** `bun run check` passes, including lint, typecheck, unit tests,
  CLI/MCP/migration acceptance tests, and the web build.

### 13.8 Definition of done

The MVP is complete when a new user can:

1. Clone the repository and install dependencies.
2. Run `slipmem init` and create fleeting, permanent, and literature notes.
3. Search and browse them locally.
4. Start the MCP server and have an agent capture a fleeting note, write a
   literature note, and propose a permanent note.
5. Approve the permanent proposal from the CLI or web review page.
6. Open a cited tag page generated on demand.
7. Delete the cache, rebuild it, and see identical content.
8. Migrate an existing SQLite database with no data loss and no source
   modification.
9. Read every note with a text editor and commit the repository to Git without
   slipmem running any Git command.

## 14. Risks and open decisions

| Risk or decision | Position for the MVP |
| --- | --- |
| Filename slug drifts after a title change | Accepted. Filename stems are immutable; add opt-in rename with link rewriting later. |
| YAML parsing edge cases | Use one safe, well-tested parser; reject executable features; preserve unknown keys. |
| Timestamp collisions | Same-second titles get a numeric suffix; the 14-digit prefix remains the creation time. |
| Approval friction | Limit approval to permanent writes and deletions; keep fleeting and literature capture direct. |
| Index drift or deletion | The index is disposable and rebuildable; `check --rebuild-index` is the recovery path. |
| Migration of malformed rows | Preserve text and report; never silently drop or truncate. |
| Git merge conflicts | Detect and report; never auto-resolve. |
| Wiki quality with a synthesizer | Extractive mode remains a fully cited fallback. Synthesized mode runs each sentence through a citation validator; unsupported sentences are dropped. |
| Multi-user sync | Out of scope. Git is the collaboration mechanism for the MVP. |
| Secret leakage | Plaintext warning, MCP policy, redaction guidance, and no secret-store claims. |
| Old type-based API clients | Keep adapters for one release and then remove with a deprecation note. |

Open decisions to resolve in Phase 0:

- Which default synthesizer to ship (local model, hosted model, or agent
  command) and how operators configure it.
- The exact tag normalization rules shared by CLI, MCP, and web.
- Whether the web API returns wiki output as rendered Markdown or structured
  sections; the default should be structured sections with a Markdown rendering
  option.
- Whether a future `slipmem rename` command rewrites wikilinks, Markdown links,
  or both. It is not required for the MVP.

## 15. Documentation and compatibility work

The implementation phases must update:

- `README.md`: repository layout, Markdown source of truth, local loop, and
  security posture.
- `packages/mcp/README.md`: tool table, approval behavior, bounded recall,
  provenance, and stdio setup.
- `packages/server/README.md`: ID-based API, compatibility routes, loopback
  warnings.
- `packages/web/README.md`: UI routes, review flow, tag pages, and local
  server behavior.
- A new operator guide covering backup, index rebuild, migration, and recovery.
- `opencode.json`: keep the stdio MCP registration working with the new entry
  point; do not hard-code a database path.

The prior SQLite-first documents should not be deleted. Mark them superseded
and link to this plan so readers can understand the migration history.
