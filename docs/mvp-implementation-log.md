# MVP implementation log

Status: **Phase 1 started; safe parser and fixture replay landed.**
Date: 2026-11-17
Authority: [`docs/mvp-plan.md`](./mvp-plan.md). This log records decisions,
baseline evidence, commit boundaries, and acceptance status. It does not replace
the plan.

## 1. Baseline before implementation

Baseline commit: `d4c0aae` (main, clean working tree).

`bun run check` passes on that commit:

- `oxlint packages`
- `tsc --noEmit` for root and `packages/web`
- `bun test`: **66 pass, 0 fail, 285 assertions, 10 files, 4.89 s**
- `vite build`: client and SSR bundles

Current architecture:

- `@slipmem/schemas` owns Effect Schema note slices, the tagged `Note.Info`
  union, drafts, and search input. IDs are arbitrary strings; timestamps are
  finite epoch milliseconds.
- `@slipmem/core` owns Effect services (`FleetingNoteService`,
  `PermanentNoteService`, `LiteratureNoteService`, `NoteService`), SQLite
  implementations, the Drizzle note tables, `NoteDatabaseService`, and test
  support that runs the production migrations.
- `@slipmem/server` owns the type-based JSON API, streamable HTTP MCP endpoint,
  tool registrations, loopback default, and migration runner. It adopts a
  populated pre-Drizzle bootstrap database instead of recreating it.
- `@slipmem/mcp` owns the stdio entry point and reuses the server tool
  registrations.
- `@slipmem/web` is a single-process Foldkit SSR app with list/detail/edit
  routes over the same SQLite database.
- Storage is SQLite-first. There is no `.slipmem/` repository, Markdown parser,
  CLI package, disposable FTS index, approval queue, wiki service, or Playwright
  setup yet.

Tooling note for a future demo video: the baseline has no Playwright or `ffmpeg`
available at the repository root. The `scripts/tour/` scaffold is committed in
`fa861b0` and its README documents a Playwright 1.64.1 silent WebM pipeline with
captions burned into the recording. It is demo tooling only: it is not a Phase 0
or Phase 1 dependency, and the storage increments do not modify it.

## 2. Resolved Phase 0 decisions

### 2.1 Wiki synthesis

- **Extractive is the default and the guaranteed fallback.** It quotes selected
  notes verbatim and cites each excerpt by note ID and file. It invents no
  prose.
- **Synthesized mode is opt-in.** `SLIPMEM_WIKI_SYNTHESIS` selects a local model
  ID or a local agent command. There is no hosted-model default and no implicit
  network dependency.
- **Citation validation is strict in every non-extractive mode.** A
  synthesized sentence without a supporting selected-note span is rejected or
  omitted before output. A local agent receives only the bounded note set, no
  tools, no write access, and no authority to act on note text.
- **Conflicts stay visible.** Notes that disagree are rendered with separate
  citations, never merged into one unattributed claim.

### 2.2 Topic slug normalization

All surfaces use one pipeline:

1. Unicode NFKD normalization, then strip combining marks.
2. Lowercase, then replace every run of characters outside `a-z`, `0-9` with a
   single `-`.
3. Trim leading/trailing hyphens.
4. Truncate to 64 characters on a hyphen boundary where possible.
5. An empty result is **invalid** for a topic. Note title slugs use the same
   pipeline with an 80-character limit and an `untitled` fallback.

Examples: `Agent Memory` -> `agent-memory`, `Café & MCP` -> `cafe-mcp`,
`日本語` -> empty (rejected). The executable rule lives in
`packages/schemas/src/markdown.ts`.

### 2.3 Wiki response shape

- Structured output is canonical: `topic`, `generatedAt`, `mode`, `noteCount`,
  `sources`, `sections`, and each section's `citations`.
- `markdown` is a rendering of the same sections for CLI use and copy/paste. It
  is never a persisted second source of truth.
- The HTTP API defaults to structured output; `format=markdown` returns only the
  rendered string. The CLI prints Markdown.

### 2.4 Frozen storage and approval rules

- Note root resolves as `SLIPMEM_DIR`, nearest ancestor `.slipmem/`, then Git
  root/current directory for `init`.
- Filenames are `YYYYMMDDHHmmss-<slug>.md`, matching
  `^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$`. The stem is the ID. The prefix is UTC
  creation time to the second.
- Same-second title collisions append `-2`, `-3`, ... after the slug; the prefix
  never changes.
- Title changes do not rename files. Unknown frontmatter keys are preserved.
- MCP permanent create/update/reclassify and every delete are pending proposals.
  Fleeting and literature writes are direct; literature still requires
  `reference`. Approval is unavailable through MCP.
- Content limits remain 1000 / 2000 / 5000 characters; note files over 1 MiB are
  rejected on read.

## 3. Baseline-plus-first increment

This commit adds only contract and fixture work; no production storage behavior
changes.

Added:

- `packages/schemas/src/markdown.ts` and its package export: filename and topic
  patterns, slug/topic normalization, UTC conversion, collision-safe filename
  generation, note metadata, approval proposal, and structured wiki schemas,
  plus search/wiki/file bounds.
- `packages/schemas/src/markdown.test.ts`: executable contract tests.
- `packages/core/fixtures/phase0/`: valid and invalid note corpus, SQLite
  current/legacy/empty/invalid-row fixtures, acceptance payload examples, and a
  fixture README.
- `packages/core/src/markdown/phase0-fixtures.test.ts`: manifest consistency,
  fixture invariants, migration SQL execution/counts, and acceptance payload
  checks.

Verification gate for this commit: `bun test` **89 pass, 0 fail, 530 assertions,
12 files**; `bun run check` passes. The previous baseline is preserved because
the new code is additive.

## 3.1 Phase 1a - safe parser and read-only note mapping

This increment adds no writes and does not touch SQLite or any surface.

Added:

- `packages/core/src/markdown/errors.ts`: one `MarkdownError` type carrying
  `area`, stable `code`, `path`, optional `field`, and an actionable message.
  Fixture manifest codes are reused verbatim.
- `packages/core/src/markdown/frontmatter.ts`: line-based frontmatter split,
  64 KiB frontmatter bound, safe `yaml` parsing with `schema: "core"`,
  duplicate-key rejection, 32-alias expansion bound, executable/local YAML tag
  rejection, dangerous-key rejection, unknown-key extraction, and canonical
  rendering with quoted timestamps.
- `packages/core/src/markdown/note-document.ts`: filename, ID, timestamp,
  type, title, topic, reference, provenance, body-limit, file-size, and
  conflict-marker validation; bidirectional `Markdown.NoteMetadata` and
  `Note.Info` mapping; SHA-256 content hash. `createMarkdownNoteDocument`
  renders and immediately re-parses so callers cannot write a file the reader
  rejects.
- `packages/core/src/markdown/note-document.test.ts`: replays every valid and
  invalid Phase 0 fixture, asserts unknown-key round trips, canonical output,
  timestamp quoting, body formatting, file-size failure, and error paths.
- `yaml@2.9.1` added to `@slipmem/core`; the parser uses only data schemas, never
  executable constructors.

Evidence: `bun test packages/core/src/markdown/note-document.test.ts` **26 pass,
0 fail, 196 assertions**; `bun run typecheck` passes; the full suite is **115
pass, 0 fail, 726 assertions, 13 files**. The 26 new tests include six valid
fixtures and thirteen invalid-fixture code matches.

## 3.2 Phase 1b/1c - root resolution, repository CRUD, lock, backups, check

This increment is filesystem-only and still does not change any surface. The
SQLite note tables remain the runtime source of truth until the Phase 5 cutover.

Added:

- `packages/core/src/markdown/root.ts`: frozen root resolution (`SLIPMEM_DIR`,
  nearest ancestor, Git root/cwd for init), idempotent `initializeNoteRoot`
  (`.state/`, README, `.gitignore`), per-root XDG state/cache paths.
- `packages/core/src/markdown/paths.ts`: strict direct-child ID/path validation,
  direct lstat and realpath symlink rejection, 1 MiB read bound, root entry
  enumeration.
- `packages/core/src/markdown/atomic.ts`: same-directory temp file, fsync,
  `link` for atomic create-only writes, `rename` for updates, temp cleanup on
  failure.
- `packages/core/src/markdown/lock.ts`: in-process per-root semaphore plus a
  `.state/repository.lock` file with token, PID, stale-age recovery, and a
  clear `repository-locked` error.
- `packages/core/src/markdown/repository.ts`: `MarkdownNoteRepository` Effect
  service and Layer with scan/list/listTitles/get/getInfo/create/update/delete,
  filename collision suffixes, type/topic/limit filters, monotonic `updatedAt`,
  unknown-metadata preservation, reclassification by metadata only, and
  move-to-backup deletes outside the root.
- `packages/core/src/markdown/check.ts`: read-only `checkNoteRoot` report for
  filename/metadata/body errors, unexpected files, duplicate IDs, slug drift,
  and optional index fingerprint drift.
- Tests: `root.test.ts` and `repository.test.ts` cover resolution, init,
  restart survival, collisions, invalid writes leaving no file, in-place update
  with unknown keys, reclassification, backed-up delete, traversal, symlinks,
  file size, live/stale locks, filters, check errors, and slug-drift warnings.

Evidence: `bun test packages/core/src/markdown/root.test.ts
packages/core/src/markdown/repository.test.ts` **19 pass, 0 fail, 82
assertions**; `bun run typecheck` and `bun run lint` pass; the full suite is
**142 pass, 0 fail, 932 assertions, 16 files**. No surface imports the new
repository yet, so the existing SQLite runtime is unchanged.

## 3.3 Phase 1d - disposable SQLite FTS index and NoteService adapter

This increment still leaves every surface on the existing SQLite services. It
adds the index beside the repository and proves the recovery and external-edit
contracts.

Added:

- `packages/core/src/markdown/search-index.ts`: `MarkdownSearchIndex` Effect
  service and scoped Layer. The SQLite file lives under the per-root XDG cache
  (or an explicit test/operator cache directory) with `0700` directory and
  `0600` file permissions.
- Schema: derived `notes` rows plus an FTS5 table with `unicode61` tokenizer.
  Schema-version mismatch drops and recreates only the derived tables. If FTS5
  creation fails, the service reports `linear` mode and keeps working.
- `refresh` compares path, mtime, and size; changed files are re-parsed and
  re-indexed, deleted files are removed, invalid files are dropped from the
  index, and the FTS table is repaired if its row count drifts.
- `rebuild` and `clear` are explicit recovery paths. `snapshot` exposes IDs and
  content hashes for `checkNoteRoot` drift reporting.
- Bounded `search` default 10 / hard maximum 50, 16 tokens, 512-character
  query, type/topic/field filters, and ranked FTS ordering. The linear fallback
  applies the same bounds and weighted matching without FTS5.
- Bounded topic counts: default 50 / hard maximum 200, sorted by count then
  slug.
- `packages/core/src/note/markdown-note.service.ts`: a `NoteService` adapter
  Layer over the repository and index, not wired into server, MCP, or web.
- `search-index.test.ts`: FTS search across all three types, field/type/topic
  filters, result and topic bounds, delete-and-rebuild identity, external edit
  visibility, deleted-file removal, forced linear fallback, index drift, file
  permissions, schema bump recovery, and the `NoteService` adapter.

Evidence: `bun test packages/core/src/markdown/search-index.test.ts` **9 pass, 0
fail, 48 assertions**; `bun run lint` passes. Focused core typecheck passes.
At this commit boundary, unrelated in-progress `packages/cli` and
`scripts/tour` work from other workers makes the root `bun run typecheck` and a
couple of tour safety tests fail; no Phase 1 file is involved.


## 4. Incremental commit strategy

Rules for every phase:

- `main` stays runnable; no commit may leave a surface unable to start.
- Ship vertical, independently testable slices. Prefer read-only behavior before
  writes, and files before the index.
- Each commit must have a test that proves the newly claimed behavior. A commit
  without a verification gate is not accepted.
- Never switch the source of truth in one commit. Add the Markdown path beside
  SQLite, prove parity, then cut over.
- Commit only the files in the current increment. Do not fold unrelated
  refactors, generated artifacts, or user work into it.
- Use Phase 0 fixtures as the stable regression corpus. When behavior changes,
  change the plan, manifest, and tests together.

Suggested commit sequence:

| Slice | Commit boundary | Verification gate |
| --- | --- | --- |
| 0 | Contract helpers + fixture corpus (this commit) | schema unit tests; fixture manifest/invariant tests; full check |
| 1a | Safe frontmatter parser + filename/metadata mapping (read-only) | replay every valid fixture to `Note.Info`; every invalid fixture returns its manifest code |
| 1b | Markdown repository read/list/get + `check` routine | fixtures; malformed path/field errors; no writes |
| 1c | Atomic create/update/delete + lock + collision suffixes | restart survival; collision; failed validation writes nothing |
| 1d | Disposable SQLite FTS index + rebuild/refresh + bounded search | delete index, rebuild, same IDs/results; external edit visible |
| 2a | CLI read commands + `init` / `check` | clean-root smoke test; bounded output |
| 2b | CLI writes + `$EDITOR` | valid writes only; atomic temp+rename |
| 2c | Migration dry run | source DB unchanged; report counts/collisions/invalid rows |
| 3a | Proposal store + local approve/reject | stale base hash refused; no MCP approval tool |
| 3b | MCP read/search/wiki parity | same shapes/limits over stdio and HTTP |
| 3c | MCP write policy + provenance | permanent/delete pending; fleeting/literature direct |
| 4a | Extractive wiki + structured/markdown rendering | every excerpt cited; empty topic invents nothing |
| 4b | Opt-in synthesizer + citation validator | unsupported sentences dropped |
| 4c | Foldkit list/detail/search/topics/wiki views | no browser-only source of truth |
| 4d | Review queue + approve/reject UI + ID-based API | cross-surface visibility; compatibility adapters |
| 5 | Real SQLite import, verification, cutover | no data loss; source untouched; Markdown-only start |
| 6 | Security/limits/docs/release | full acceptance matrix; fresh and migrated clones |

## 5. Acceptance tracking

Status legend: **done** = implemented and tested against the real surface;
**partial** = contract/fixtures only; **not started**.

| Area | Criteria | Status | Evidence or next gate |
| --- | --- | --- | --- |
| Phase 0 contract | Filename, metadata, topic, approval, wiki rules frozen | done | `packages/schemas/src/markdown.ts`, 12 tests |
| Phase 0 note fixtures | Valid/invalid corpus, Unicode, collisions, long titles, every type, malformed YAML, conflicts | done | `fixtures/phase0/notes`, manifest tests |
| Phase 0 migration fixtures | Current, legacy, empty, invalid rows | done | executable SQL + row/column tests |
| Phase 0 examples | CLI, API, MCP payloads | done | `acceptance/examples.json` tests |
| STOR-01..08 | Flat `.slipmem/`, filenames, frontmatter, limits, collisions, unknown keys, atomic failure | done | Parser + `MarkdownNoteRepository` + `check`; `repository.test.ts` covers 01-08 |
| TRUTH-01..04 | Disposable index, files-only recovery, external edits, no SQLite runtime | partial | Index rebuild identity and external-edit refresh tested; repository restart tested; cutover remains Phase 5 |
| SURFACE-01..05 | CLI/MCP/web parity, same tool schemas, ID routes, adapters | not started | Phases 2-4 |
| APPROVE-01..09 | Pending permanent/delete, direct fleeting/literature, stale hash, no MCP approval | partial | Proposal/wiki schemas only; Phase 3 |
| WIKI-01..07 | Bounded selection, citations, empty/conflict handling, no persisted page, injection-safe synthesis | partial | Wiki schemas only; Phases 4a-4b |
| MIGRATE-01..06 | Lossless import, untouched source, dry run, idempotency, check, malformed reporting | partial | Fixtures only; Phases 2c and 5 |
| SEC-01..06 | Paths, size bounds, loopback, untrusted text, no Git actions, full check | partial | Bounds and patterns only; Phase 6 |
| Definition of done | Full local loop and migration in section 13.8 | not started | Final acceptance run |

This Phase 1 set claims the parser, repository, check, and index behavior listed
above. It does not claim CLI/MCP/web parity, approvals, wiki generation, or the
SQLite cutover.

## 6. Architectural pointers

- Plan: `docs/mvp-plan.md` sections 5 (storage), 8 (approval), 9 (wiki), 10
  (phases), 13 (acceptance).
- Contract helpers: `packages/schemas/src/markdown.ts`.
- Contract tests: `packages/schemas/src/markdown.test.ts`.
- Fixture corpus: `packages/core/fixtures/phase0/README.md`.
- Fixture tests: `packages/core/src/markdown/phase0-fixtures.test.ts`.
- Existing SQLite behavior to preserve until cutover:
  `packages/core/src/note/SQLite-note.service.ts`,
  `packages/server/src/migrations.ts`, `packages/server/src/note-tools.ts`.
- Existing limits and schema style: `packages/schemas/src/*-note.ts`.

## 7. Phase 1 implementation choices (resolved)

- **YAML:** `yaml@2.9.1` with the core schema, no executable constructors,
  bounded aliases, unsafe-tag rejection, and a separate unknown-key record.
  `Schema.decode` is not used for frontmatter round trips.
- **Writes and locks:** same-directory temp file plus fsync and link/rename;
  lock file at `.slipmem/.state/repository.lock`; in-process per-root semaphore.
- **Deletes:** move to
  `$XDG_STATE_HOME/slipmem/trash/<root-hash>/` by default, with a cross-device
  copy fallback; never an in-place unlink.
- **Index:** `$XDG_CACHE_HOME/slipmem/index/<root-hash>/index.sqlite`, FTS5 when
  available, bounded linear scan otherwise; schema version mismatch is a
  derived-table rebuild.
- **Errors:** `MarkdownError` carries `area`, `code`, `path`, optional `field`,
  and a message. Fixture manifest codes are preserved; new repository, path, and
  index codes are additive and not yet a public API promise.

## 8. Recommended next bounded task

Implement the **first read-only surface wiring** on top of Phase 1, without
cutting over the source of truth.

Scope:

1. Provide a small application factory that resolves the note root, builds
   `MarkdownNoteRepositoryLive`, `MarkdownSearchIndexFromRepository`, and the
   `MarkdownNoteService` adapter behind an explicit feature flag.
2. Use it for one read-only path (CLI `list`/`show` or a health/list endpoint)
   while SQLite remains the default for writes and all existing routes.
3. Run `checkNoteRoot` with the index snapshot in that path and surface the
   report without mutating notes.
4. Prove the flag-off runtime is byte-for-byte the current SQLite behavior and
   the flag-on path reads only `.slipmem/*.md`.
5. Run the full `bun run check` and commit only the wiring and its tests.

Approval proposals, migration cutover, wiki generation, and MCP write policy
remain later phases. The repository/index interfaces are ready; the next worker
should not duplicate parser, path, locking, or ranking rules.
