# MVP implementation log

Status: **Phase 0 started; contract frozen and fixtures added.**
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
available at the repository root. A separate, currently uncommitted
`scripts/tour/` scaffold exists outside this commit; its README documents a
Playwright 1.64.1 silent WebM pipeline with captions burned into the recording.
Treat that as a candidate demo pipeline to verify and commit separately when a
demo deliverable exists. It is not a Phase 0 dependency and this increment does
not claim it.

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
| STOR-01..08 | Flat `.slipmem/`, filenames, frontmatter, limits, collisions, unknown keys, atomic failure | not started | Phase 1 repository + `check` |
| TRUTH-01..04 | Disposable index, files-only recovery, external edits, no SQLite runtime | not started | Phase 1d, Phase 5 |
| SURFACE-01..05 | CLI/MCP/web parity, same tool schemas, ID routes, adapters | not started | Phases 2-4 |
| APPROVE-01..09 | Pending permanent/delete, direct fleeting/literature, stale hash, no MCP approval | partial | Proposal/wiki schemas only; Phase 3 |
| WIKI-01..07 | Bounded selection, citations, empty/conflict handling, no persisted page, injection-safe synthesis | partial | Wiki schemas only; Phases 4a-4b |
| MIGRATE-01..06 | Lossless import, untouched source, dry run, idempotency, check, malformed reporting | partial | Fixtures only; Phases 2c and 5 |
| SEC-01..06 | Paths, size bounds, loopback, untrusted text, no Git actions, full check | partial | Bounds and patterns only; Phase 6 |
| Definition of done | Full local loop and migration in section 13.8 | not started | Final acceptance run |

This increment does **not** claim any STOR/TRUTH/SURFACE/APPROVE/WIKI/MIGRATE
behavior; it makes those criteria testable.

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

## 7. Open implementation choices for Phase 1

- Safe YAML parser dependency. It must reject tags/custom constructors, preserve
  unknown keys, and distinguish malformed YAML from invalid known fields. No YAML
  parser is installed yet.
- Atomic write mechanics and lock location under `.slipmem/.state/`.
- FTS5 schema and cache path keying (`$XDG_CACHE_HOME/slipmem/<root-hash>`), plus
  the bounded linear-scan fallback.
- Exact error codes used by the repository and surfaced by CLI/MCP/web. The
  fixture manifest codes are a starting vocabulary, not a public API promise.

## 8. Recommended next bounded task

Implement **Phase 1a: safe frontmatter parsing and read-only note mapping**.

Scope:

1. Add a safe YAML/frontmatter parser in `packages/core/src/markdown/`.
2. Map parsed metadata + body to `Note.Info` (or a Markdown-specific Info shape
   if `type`/timestamps need a compatibility adapter) using the Phase 0
   constants.
3. Implement filename/ID/timestamp/type/reference/content-limit/conflict-marker
   validation with actionable path and field errors.
4. Replay `fixtures/phase0/notes` in tests: every valid fixture parses; every
   invalid fixture fails with its manifest code. No file writes yet.
5. Run `bun run check` and commit only the parser/mapping/tests (plus any
   necessary dependency and lockfile change).

This slice is bounded, proves the frozen corpus against real parsing, and
unblocks Phase 1b repository tests without committing to storage cutover.
