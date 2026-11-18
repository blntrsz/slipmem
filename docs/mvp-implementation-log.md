# MVP implementation log

Status: **Phases 0-5 implemented on `main`; hardening and release verification
are in progress.** The criterion-by-criterion record is now
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md).
Date: 2026-11-18
Evidence snapshots: `29b7dd1` through `84d02ab` plus the in-flight web work
called out in the matrix; other workers committed concurrently, so the final
release gate must be rerun on the landed tree.
Authority: [`docs/mvp-plan.md`](./mvp-plan.md). This log records decisions,
baseline evidence, commit boundaries, and acceptance status. It does not replace
the plan, and it does not turn an evidence note into a passing test.

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
  unknown-metadata preservation on create/update (including migration `legacyId`
  and compatibility fields), reclassification by metadata only, and
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
A follow-up hardening pass rejects dangerous keys recursively in decoded YAML,
returns typed errors when a root entry disappears during inspection, and refuses
to place the index inside the note root. The combined parser/repository/index
suite is **50 pass, 0 fail, 314 assertions** across 3 files.

At the original Phase 1d commit boundary, unrelated in-progress `packages/cli`
and `scripts/tour` work from other workers made the root typecheck and a couple
of tour safety tests fail. Those workers have since committed and the root
typecheck passes; see the final handoff gate.

## 3.4 Phase 1 handoff gate

Phase 1 slices are committed as:

- `9620de9` safe parser and fixture replay
- `a8ecca9` root resolution, repository CRUD, lock, backups, and `check`
- `13340eb` disposable FTS index and `NoteService` adapter
- `36a3e7c` parser/path/index hardening

Full gate at this boundary: `bun run check` passes - oxlint, root and web
typecheck, `bun test` **191 pass, 0 fail, 1147 assertions, 21 files**, and the
Vite client/SSR web build. The existing server, MCP, and web runtime still use
SQLite; no surface was cut over.

Interfaces ready for the next worker:

- `resolveNoteRoot`, `initializeNoteRoot`, `MarkdownNoteRepositoryLive`
- `MarkdownNoteRepository` (`list`, `listNotes`, `listTitles`, `get`, `getInfo`,
  `create`, `update`, `delete`, `scan`)
- `checkNoteRoot` and `indexFingerprints`
- `MarkdownSearchIndexLive` / `MarkdownSearchIndexFromRepository`
  (`refresh`, `rebuild`, `clear`, `search`, `searchNotes`, `listTopics`,
  `snapshot`, `status`)
- `MarkdownNoteService` implementing the existing `NoteService` contract

Post-gate refinements in `f54fdac`, `3fbac5c`, `aa7a405`, and `77b92fe` align
list limits with the recall contract, return typed errors on note-path races,
export root constants used by surface wiring, and let create/update preserve
migration compatibility metadata. Focused verification after those changes:
`bun test packages/core/src/markdown` **70 pass, 0 fail, 538 assertions**; a
scoped `tsc` over `packages/core/src` plus `packages/schemas/src` passes. Full
check re-runs at the actual handoff were blocked by unrelated, uncommitted
approval/MCP/server/CLI work from other workers; the last green full gate was
`7904945`.


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

## 5. Acceptance tracking and current status

Status legend: **pass** = a committed test or named independent run exercises
the clause at the matrix snapshot; **conservative** = the literal clause is met
by a documented narrower behavior; **partial** = some clauses are proven and
some are not; **pending** = implementation exists but the gate is not green or
the end-to-end path has not been rerun; **missing** = the requirement is absent.

The detailed criterion-by-criterion record, exact test names, commits, browser
run, migration adversarial run, and open gaps live in
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md). This section
keeps only the phase-level summary.

| Area | Criteria | Status | Evidence or next gate |
| --- | --- | --- | --- |
| Phase 0 contract | Filename, metadata, topic, approval, wiki rules frozen | pass | `packages/schemas/src/markdown.ts`; hardened in `8b4d463`; contract evidence in `docs/mvp-contract-verification.md` |
| Phase 0 fixtures | Notes, Unicode, collisions, every type, malformed YAML, migration shapes, payloads | pass | `packages/core/fixtures/phase0/`; `phase0-fixtures.test.ts`; migration fixture parity guard is still missing (matrix G5) |
| STOR-01..08 | Flat `.slipmem/`, filenames, frontmatter, limits, collisions, unknown keys, atomic failure | pass | Parser, `MarkdownNoteRepository`, `check`; `repository.test.ts`; `docs/mvp-storage-review-fixes.md` |
| TRUTH-01..04 | Disposable index, files-only recovery, external edits, no SQLite runtime | pass | `search-index.test.ts`; surface startup paths; copy-only smoke in the matrix |
| SURFACE-01..05 | CLI/MCP/web parity, same tool schemas, ID routes, adapters | pass | CLI, MCP, server, and web suites; `docs/mvp-cli-evidence.md`, `docs/mvp-mcp-evidence.md`, `docs/mvp-web-evidence.md` |
| APPROVE-01..09 | Pending permanent/delete, direct fleeting/literature, stale hash, no MCP approval | pass | `packages/core/src/approval/approval.test.ts`; CLI/server approval tests; `docs/mvp-approval-wiki-evidence.md`; CAS commits `f6641c5`, `cef9d19` |
| WIKI-01..07 | Bounded selection, citations, empty/conflict handling, no persisted page, injection-safe synthesis | pass, conservative synthesis | `packages/core/src/wiki/wiki.test.ts`; CLI wiki tests; `docs/mvp-approval-wiki-evidence.md`; exact extractive support only |
| MIGRATE-01..06 | Lossless import, untouched source, dry run, idempotency, check, malformed reporting | partial | `migration-*.test.ts`; CLI migrate tests; `docs/mvp-migration-evidence.md`; independent `/tmp/opencode/mig/EVIDENCE.md`; real-DB fixture parity still open (matrix G5) |
| SEC-01..05 | Paths, size bounds, loopback, untrusted text, no Git actions | pass | Storage, CLI, server, web, and browser evidence |
| SEC-06 | `bun run check` passes | pass (provisional) | Run 3: lint clean, root/web typecheck clean, 341 pass / 0 fail / 2859 expect calls, Vite client and SSR builds successful. The green run includes uncommitted `packages/web/**` edits; repeat on the landed tree. |
| Definition of done | Full local loop and migration in section 13.8 | partial | Local loop is exercised; clean clone, real representative DB import, and final gates remain |

### 5.1 Phase 2-6 landing record

The Phase 1 log above is historical. The later phases landed as vertical
slices:

- **CLI (`packages/cli`).** `f032517`, `4947344`, `80232f9`, `7c79865`,
  `df9466a`, `3cd3942`, `955ee07`, `46eff30`, `df90921`, `ee6705a`.
  Commands cover init, create, list, show, edit, delete, search, topics, check,
  wiki (extractive + synthesized), migrate, review, approve, reject, and the
  MCP/web wrappers. Evidence: `docs/mvp-cli-evidence.md`.
- **MCP parity and approvals.** `9c8f771`, `e6b2260`, `91e18f6`, `88035a8`,
  `e176d6e`, `3c36f7e`. Both transports share `McpNoteRegistrations`; the MCP
  process receives only `submitMcp`. Evidence: `docs/mvp-mcp-evidence.md`.
- **Approval and wiki core.** `1bd37b4`, `465ac9e`, `925f622`, `4febd88`,
  `96f723d`, `df90921`, `cef9d19`, `f6641c5`, `4164078`. Pending
  permanent/deletes, direct fleeting/literature, under-lock CAS, extractive
  citations, fail-closed synthesis, and bounded output. Evidence:
  `docs/mvp-approval-wiki-evidence.md`.
- **Web/API cutover.** `7a1b677`, `2f4cac7`, `8a35212`, `1a9cb8c`,
  `4ea0678`. Canonical ID API, type adapters, Foldkit routes, review queue,
  wiki, and health. Evidence: `docs/mvp-web-evidence.md`; independent browser
  report at `/tmp/opencode/browser-acceptance/REPORT.md`.
- **Migration hardening.** `70c6117`, `dd9d941`, `752803a`, `8677012`,
  `2d8ba25`, `b19f137`, `f4a4b76`, `5fbfc05`, `efac3f2`, `ee6705a`. Read-only
  private source snapshot, exact integers/blobs, live-lock protection,
  interrupted-run recovery, truthful skipped paths, and verification status.
  Evidence: `docs/mvp-migration-evidence.md`; independent migration log at
  `/tmp/opencode/mig/EVIDENCE.md`.
- **Link checking.** `463741c`. `check` validates wikilinks and direct `.md`
  links and returns check-time backlinks. Evidence:
  `docs/mvp-link-check-evidence.md`.

### 5.2 Open release gaps

The matrix is authoritative; these are the bounded items that must not be
mistaken for done:

1. **G1, clear-cache command.** Plan §12 requires one; only
   `check --rebuild-index` and manual cache removal exist.
2. **G2, backlinks in the index.** Plan §5.6 says the index records backlinks;
   today `check` derives them in memory only.
3. **G3, migration source default.** `--db` is mandatory; the Phase 5 plan says
   to support the current default path and `SLIPMEM_DB_PATH`.
4. **G4, read-only old-DB compatibility path.** Not implemented; the SQLite
   archive is untouched but no runtime reads it.
5. **G5, real migration fixture parity.** Current fixtures are hand-written and
   match the checked-in migration SQL today, but no test creates the source by
   running the real migrations.
6. **G6, synthesized semantic validity.** The validator proves exact extractive
   support, not entailment. This is a documented conservative implementation of
   the plan, not a semantic guarantee.
7. **G7, browser low-severity UX fixes.** D1-D4 from the independent browser run
   were being addressed in uncommitted web work at this snapshot; rerun the
   browser acceptance after they land.
8. **G8, residual low migration reporting item.** Verify the
   duplicate-`legacyId`-across-tables merge warning still described by the
   independent migration log.
9. **SEC-06/final gate.** The current working tree passes `bun run check`
   (provisional, because web edits are uncommitted). Repeat it after those edits
   land and add a clean-clone smoke run before a release claim.

## 6. Architectural pointers

- Plan: `docs/mvp-plan.md` sections 5 (storage), 8 (approval), 9 (wiki), 10
  (phases), 13 (acceptance).
- Contract helpers: `packages/schemas/src/markdown.ts`.
- Contract tests: `packages/schemas/src/markdown.test.ts`.
- Fixture corpus: `packages/core/fixtures/phase0/README.md`.
- Fixture tests: `packages/core/src/markdown/phase0-fixtures.test.ts`.
- Current criterion record: `docs/mvp-acceptance-matrix.md`.
- Current runtime paths: `packages/server/src/markdown.ts`,
  `packages/mcp/src/layer.ts`, `packages/cli/src/context.ts`,
  `packages/web/src/entry.server.ts`.
- Historical SQLite code kept only for migration/compatibility:
  `packages/core/src/note/SQLite-note.service.ts`,
  `packages/server/src/database.ts`, `packages/server/src/migrations.ts`.
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

## 8. Recommended next bounded tasks

The Phase 1 surface-wiring task is complete; CLI, MCP, web, approval, wiki, and
migration all consume the Markdown services. The remaining work is release
hardening, not a source-of-truth cutover.

1. **Finish the in-flight web UX fixes** for browser findings D1-D4, then rerun
   the independent browser acceptance and record a fresh report.
2. **Repeat the clean full gate** (`bun run check`) and run a clean-clone
   quickstart after the web edits land. The current working tree passes, but that
   run includes uncommitted files.
3. **Decide and implement the explicit plan gaps:** clear-cache command (G1),
   index-recorded backlinks (G2), migration default source (G3), and the
   read-only legacy DB compatibility path (G4). Each needs either a narrow
   implementation or a plan amendment; do not leave them implicit.
4. **Add real migration fixture parity** (G5): create a source DB through the
   actual checked-in migration path, insert representative rows, and import it
   in a regression test.
5. **Re-check the residual migration warning** in G8 and the synthesized-wiki
   wording in G6. Keep semantic entailment out of any claim.

Do not duplicate the parser, path, locking, ranking, approval, or wiki rules in
a surface. The acceptance matrix is the source of truth for what is still open.
