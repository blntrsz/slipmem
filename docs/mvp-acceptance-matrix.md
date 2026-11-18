# MVP acceptance matrix

Date: 2026-11-18
Authority: [`docs/mvp-plan.md`](./mvp-plan.md) section 13.
Evidence snapshots: `29b7dd1` through `84d02ab` plus the uncommitted web work
described below. Other workers committed concurrently while this note was
written, so the quoted test counts are run boundaries, not a frozen tree hash.
The green run is provisional and must be repeated on the landed tree before
release.

This matrix records what the repository can actually prove, criterion by
criterion. It is deliberately not a release checklist with optimistic ticks.
Every **Pass** names a committed test or a command result; a criterion is
**Partial** when only part of its clause is exercised, and **Pending** when the
implementation exists but the current tree has not produced a clean gate or the
named surface has not been verified together.

Legend:

- **Pass** - the clause is exercised by a committed test or a named independent
  run at this snapshot.
- **Pass (conservative)** - the literal clause is met by a deliberately narrower
  implementation; the narrower behavior is documented and is not being hidden.
- **Partial** - some clauses are proven, some are not.
- **Pending** - code or evidence exists, but the named gate is not green or the
  end-to-end path has not been rerun at this snapshot.
- **Pass (provisional)** - the gate is green on the current working tree, but
  the run includes uncommitted changes and must be repeated after they land.
- **Missing** - the requirement is absent, not merely conservative.

## 0. Verification snapshot

Commands run for this matrix:

```text
$ bun run check        # run 1
oxlint: clean
tsc --noEmit (root and packages/web): clean
bun test: 334 pass, 1 fail, 2803 expect() calls, 39 files
web:build: not reached because the test gate failed

failure:
packages/cli/src/wrappers.test.ts
"web starts the local web server and serves the resolved root"
The web wrapper returned HTTP 500 while serving /api/health.

$ bun run check        # run 2, after the web edit progressed
oxlint: one warning in an in-flight test file, no lint failure
tsc --noEmit (root and packages/web): clean
bun test: 340 pass, 1 fail, 1 unhandled error, 2834 expect() calls, 40 files
web:build: not reached because the test gate failed

failure:
packages/cli/src/migrate.test.ts
"imports atomically with a verified backup and then skips duplicates in merge mode"
timed out at 5 s; the follow-up merge invocation was killed with status 143.

focused reruns after the relevant fixes landed:
bun test packages/cli/src/wrappers.test.ts  -> 2 pass, 0 fail
bun test packages/cli/src/migrate.test.ts   -> 5 pass, 0 fail, 80 expect calls

$ bun run check        # run 3, green
oxlint: clean
tsc --noEmit (root and packages/web): clean
bun test: 341 pass, 0 fail, 2859 expect() calls, 40 files
vite build: client and SSR bundles written successfully
```

Runs 1 and 2 overlapped active web and migration edits and are retained here as
the honest history. The fixes landed, focused reruns passed, and run 3 gives a
clean full gate. Run 3 still includes **uncommitted** web edits
(`packages/web/**`, plus the corresponding uncommitted docs/README edits), so
SEC-06 is a provisional pass: repeat `bun run check` on the landed tree before a
release claim.

Independent runs incorporated:

- Browser acceptance, 2026-11-17/18:
  `/tmp/opencode/browser-acceptance/REPORT.md`. Production bundle, isolated XDG
  roots, hydrated Foldkit UI. Main run **25/25** checks, supplemental review-diff
  XSS **2/2**, zero normal-flow console/page/request errors. No blocker defect.
- Migration adversarial verification, 2026-11-17/18:
  `/tmp/opencode/mig/EVIDENCE.md`. Focused planner/importer/CLI suites passed
  (`24 pass, 0 fail`), plus WAL, backup, crash, concurrency, symlink, and integer
  probes. Its defects correspond to fixes in commits `752803a`, `8677012`,
  `2d8ba25`, `b19f137`, `f4a4b76`, `5fbfc05`, and `efac3f2`.
- Copy-only recovery smoke, this matrix:
  `/tmp/opencode/truth02-smoke.ts` and `.log`. Two note files (and nothing else)
  were copied into a fresh `.slipmem/`; CLI list/search exited 0, `GET
  /api/notes` returned 200 with both notes, and stdio MCP `search_notes`
  returned both. This supports TRUTH-02 but is a manual probe, not a committed
  regression test.

## 1. Storage (13.1)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| STOR-01 `init` creates `.slipmem/`; notes are direct children | Pass | `packages/core/src/markdown/root.test.ts` "creates the root, state, README, and gitignore idempotently"; `packages/cli/src/init.test.ts` "creates a flat repository through the root script and is idempotent"; commit `a8ecca9` | `initializeNoteRoot` and repository create are exercised through the real CLI. |
| STOR-02 No type directories under `.slipmem/` | Pass | `packages/cli/src/init.test.ts` flat-layout assertions; `packages/server/src/app.test.ts` "canonical ID routes create, read, update, list, and delete flat Markdown notes"; browser report check 22 | The browser run observed only `.state/` as a directory and six flat note files. Compatibility adapters also assert no type folders. |
| STOR-03 Filename pattern and UTC-second prefix | Pass | `packages/schemas/src/markdown.test.ts` "builds filenames and resolves same-second collisions", "parses only real UTC filename prefixes"; `packages/core/src/markdown/note-document.test.ts` valid/invalid fixture replays; commits `9620de9`, `8b4d463` | Invalid fixtures fail with the frozen area/code. |
| STOR-04 Valid frontmatter and `id` equals stem | Pass | `packages/core/src/markdown/note-document.test.ts` "parses valid fixture ..." and "fails ... with ..."; `packages/schemas/src/markdown.test.ts` "decodes complete note metadata" | Required keys, real dates, and `updatedAt >= createdAt` are decoded. |
| STOR-05 Literature reference required; per-type limits | Pass | `packages/schemas/src/markdown.test.ts` "requires a non-blank reference for literature notes only"; `packages/core/src/markdown/repository.test.ts` "enforces type-specific content and reference rules before writing"; CLI `notes.test.ts` "validates type-specific rules and empty content with typed errors" | Limits are 1000/2000/5000 characters plus the 1 MiB file read bound. |
| STOR-06 Same-second titles get distinct names, same prefix | Pass | `packages/core/src/markdown/repository.test.ts` "resolves same-second filename collisions without changing the prefix"; schema collision test | The suffix is `-2`, `-3`, ... after the slug. |
| STOR-07 Unknown frontmatter survives round trip | Pass | `packages/core/src/markdown/note-document.test.ts` "preserves unknown frontmatter keys across a write/read round trip"; `repository.test.ts` "updates in place, preserves unknown metadata, and writes nothing on failure"; commit `f37cff9` | Unknown nested provenance extras are also preserved; dangerous keys are rejected. |
| STOR-08 Malformed note reports path/field; no partial file | Pass | `packages/core/src/markdown/repository.test.ts` update-failure test; `note-document.test.ts` error-path fixtures; `packages/cli/src/notes.test.ts` "edits through a validated temporary draft and preserves atomicity" | Failures leave the original byte-identical. Atomic create/update modes are covered in the storage review evidence. |

## 2. Source of truth and recovery (13.2)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| TRUTH-01 Delete index, rebuild, same IDs/list/search | Pass | `packages/core/src/markdown/search-index.test.ts` "deleting the index and rebuilding returns the same IDs and search results"; CLI `search.test.ts` "checks a clean root, reports errors, and rebuilds the index"; commit `13340eb` | The index remains disposable; `check --rebuild-index` is the documented recovery path. |
| TRUTH-02 Only `.slipmem/*.md` starts CLI, MCP, and web | Pass (manual probe) | `/tmp/opencode/truth02-smoke.ts` + `.log`; existing surface tests: `packages/mcp/src/main.test.ts` "stdio tool calls read the same disposable Markdown root", `packages/server/src/app.test.ts` "files written by another surface are visible without restart" | The manual probe copied only note files into a fresh root and exercised CLI, API, and stdio MCP. There is no committed test that specifically starts all three from a note-only copy; add one if this clause needs permanent regression coverage. |
| TRUTH-03 External editor edit visible after refresh | Pass | `packages/core/src/markdown/search-index.test.ts` "refreshes an externally edited file and removes deleted files" and "refreshes an external edit that preserves size and mtime"; MCP `tools.test.ts` "search sees an external markdown edit after refresh"; commit `a2a6009` | Refresh compares the SHA-256 content hash, not only size/mtime. |
| TRUTH-04 No runtime path requires SQLite note tables after cutover | Pass | `packages/server/src/markdown.ts` and `packages/server/src/app.ts` build the Markdown layer; `packages/web/src/entry.server.ts` mounts it; MCP `layer.ts` and CLI `context.ts` use the repository; `packages/server/src/database.ts` is exported only for the migration/compatibility window and is used by `migrations.test.ts` | `resolveDatabasePath()` creates a parent directory if called, but no HTTP/CLI/MCP/web startup path calls it. The old SQLite file is not a runtime source of truth. |

## 3. CLI, MCP, and web parity (13.3)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| SURFACE-01 CLI note immediately readable by MCP and web | Pass | `packages/server/src/app.test.ts` "files written by another surface are visible without restart"; MCP `tools.test.ts` external-edit test; browser report check 12 (external CLI note visible after navigation); `/tmp/opencode/truth02-smoke.ts` | Browser check 12 used the real CLI and hydrated UI. |
| SURFACE-02 stdio and HTTP MCP expose same names/schemas/limits/shapes | Pass | `packages/server/src/mcp-markdown.test.ts` "HTTP MCP uses the same Markdown registrations and approval policy as stdio"; `packages/mcp/src/main.test.ts` stdio initialize/tools; commits `91e18f6`, `e176d6e` | Both transports consume `McpNoteRegistrations` and `makeMarkdownServicesLayer`; the HTTP test also checks no approve/reject/apply tool. |
| SURFACE-03 Web list/search/topics show all three types, no type folders | Pass | `packages/web/src/main.test.ts` list/search/topics view tests; browser report checks 1, 8, 9, 22; server `app.test.ts` search/topics test | The browser found a count inconsistency for fleeting notes (D1), not a missing type. D1 is an open UX fix, not a storage-layout failure. |
| SURFACE-04 Web API uses stable note IDs, not array positions or SQLite ids | Pass | `packages/server/src/app.test.ts` "canonical ID routes create, read, update, list, and delete flat Markdown notes"; `packages/web/src/main.test.ts` ID-based detail/delete tests; commit `7a1b677` | IDs are filename stems. |
| SURFACE-05 Type route compatibility resolves through the same repository, no new layout | Pass | `packages/server/src/app.test.ts` "legacy type routes are thin adapters over the same ID repository"; browser check 22; commit `7a1b677` | A note fetched through the wrong type route returns 404; adapters create no folders. |

## 4. Approval (13.4)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| APPROVE-01 MCP permanent create/update is pending; no file change | Pass | `packages/core/src/approval/approval.test.ts` "MCP permanent create stays pending, reviews, and applies atomically"; "permanent update and reclassification are pending; rejection changes nothing"; MCP `tools.test.ts` permanent-create and stale-update tests | Pending creates reserve an ID but write no note. |
| APPROVE-02 MCP literature create/update writes directly with `source: mcp` | Pass | `approval.test.ts` "fleeting and literature writes are direct with MCP provenance"; MCP `tools.test.ts` direct writes test; commit `1bd37b4` | Reference is still required by the shared schema. |
| APPROVE-03 MCP delete of any note is pending; nothing deleted | Pass | `approval.test.ts` "any MCP delete is pending, deletes nothing, and applies into a backup"; MCP `tools.test.ts` every-delete test; commit `88035a8` | Applies through the repository backup move, not unlink. |
| APPROVE-04 `slipmem approve` applies atomically; visible to CLI/MCP/web | Pass | CLI `approval.test.ts` "reviews a pending permanent proposal and applies it atomically"; server `app.test.ts` "pending human review exposes a diff and approves or rejects without MCP approval"; browser report checks 14-15 | Browser check 15 confirmed CLI and web visibility after approval; MCP reads the same repository. |
| APPROVE-05 `slipmem reject` leaves notes unchanged | Pass | CLI `approval.test.ts` "reject removes the proposal without creating or changing a note"; core rejection test; browser check 16 | Reject deletes only the proposal record. |
| APPROVE-06 Stale base hash rejected without overwriting | Pass | `approval.test.ts` stale update/delete tests and under-lock CAS interleaving tests; CLI `approval.test.ts` stale test; MCP stale-update test; commits `f6641c5`, plus `cef9d19` | Repository re-reads and compares the hash inside `withRepositoryLock`; the pre-check is descriptive only. |
| APPROVE-07 No MCP tool can approve/reject | Pass | MCP `tools.test.ts` "exposes the bounded read surface" asserts no approve/reject/apply names; "the MCP process receives only the submitMcp approval capability"; `mcp-markdown.test.ts`; commit `3c36f7e` | The capability is projected at runtime and in types. |
| APPROVE-08 MCP fleeting create/update direct with `source: mcp` | Pass | `approval.test.ts` direct fleeting/literature test; MCP `tools.test.ts` direct writes test | Policy is fail-closed for unknown env values. |
| APPROVE-09 Pending proposals never appear in notes/lists/search/topics/wiki or `.slipmem/*.md` | Pass | `approval.test.ts` "stores proposals as local state, never as note files"; MCP pending tests assert no note file; proposal-store test paths | Proposal records live under `.state/pending/`; they are not scanned as notes. No dedicated wiki-leak test exists, but the wiki selector consumes repository notes only. |

## 5. Topic wiki (13.5)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| WIKI-01 Bounded topic selection only | Pass | `packages/core/src/wiki/wiki.test.ts` topic-first selection, default fleeting exclusion, explicit inclusion, title fallback, limit tests; CLI `wiki.test.ts`; MCP `tools.test.ts` wiki test; commit `465ac9e` | Default 10, hard maximum 25; exact topic matches rank first. No semantic/vector ranking. |
| WIKI-02 Every factual excerpt/sentence has adjacent ID and file citation | Pass | `wiki.test.ts` cited sections and structured-field bounds; `render.ts`; CLI wiki test; browser check 9 | Bounding drops whole trailing sections/citations rather than cutting a citation mid-line. |
| WIKI-03 Empty topic invents nothing | Pass | `wiki.test.ts` "returns an empty cited-free page and suggestions when nothing matches"; CLI `wiki.test.ts` empty-topic test | Empty result plus bounded suggestions. |
| WIKI-04 Conflicts stay separate with citations | Pass | `wiki.test.ts` "keeps conflicting notes in separate cited sections" | No merge into an unattributed claim. |
| WIKI-05 Wiki writes nothing under `.slipmem/` unless explicit outside output | Pass | `wiki.test.ts` "treats injection text as quoted data and writes nothing"; CLI `wiki.test.ts` `--out` inside/outside and symlinked-parent tests; browser check 9 | CLI `--out` resolves the parent's real path and rejects the note root. |
| WIKI-06 Note text is data; embedded instructions not followed | Pass | `wiki.test.ts` injection test; sandbox/argv tests; MCP instructions test; browser XSS checks | Extractive mode quotes text. Synthesized mode sends bounded JSON on stdin; no note text enters argv or environment. |
| WIKI-07 Configured synthesizer produces a cited page; validator drops unsupported sentences | Pass (conservative) | `wiki.test.ts` "accepts only sentences with exact support spans from a real child process"; opposite-claim, paraphrase, empty-output, sandbox, secret-env, unregistered-model, and malformed-output tests; CLI `wiki.test.ts` agent tests; commits `cef9d19`, `df90921`, `4164078` | The validator checks **exact extractive support**, not semantic entailment. A paraphrase, negation, or opposite claim is omitted even with a real nearby span. This satisfies the literal §13.5 clause by being stricter, but it is not a general semantic-validity proof. Sandbox default is fail-closed bubblewrap; the unsafe no-sandbox opt-in is documented. No hosted model adapter ships; `--model` fails closed unless the embedding app registers the exact ID. |

## 6. Migration (13.6)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| MIGRATE-01 Representative current DB imports with fields preserved | Partial | `packages/core/src/migration/migration-import.test.ts` current fixture import (types, titles, content, reference, timestamps, `legacyId`); `migration-plan.test.ts` current fixture mapping; CLI `migrate.test.ts` current fixture import; independent `/tmp/opencode/mig/EVIDENCE.md` | The "current" fixture is hand-written `packages/core/fixtures/phase0/migration/current.sql`. Its columns currently match `packages/server/drizzle/20261114044257_init/migration.sql`, but no test creates the source by running the real checked-in migrations. A real representative database has not been committed as a fixture. See gap G5. |
| MIGRATE-02 Source unchanged; backup created | Pass | `migration-import.test.ts` current fixture source-unchanged + backup integrity/table counts; WAL backup test; CLI `migrate.test.ts` SHA assertion; independent WAL and backup probes | Backup is `VACUUM INTO` under `.state/migrations/<run>/source-backup.db`, then opened read-only and integrity-checked. |
| MIGRATE-03 Dry run writes no notes; reports counts/collisions/invalid rows | Pass | `migration-import.test.ts` "a dry run reports the plan without writing anything" and WAL dry-run test; CLI `migrate.test.ts` dry-run test | Planning reads a private snapshot of the DB and `-wal`/`-journal`, so it does not create `-shm` beside the source. |
| MIGRATE-04 Merge rerun does not duplicate | Pass | `migration-import.test.ts` merge idempotence, merge collision, and interrupted-run recovery tests; CLI merge test; commits `f4a4b76`, `5fbfc05` | Skips by `legacyId`, reports actual existing paths, and marks dead-owner `running` manifests `interrupted`. |
| MIGRATE-05 Imported notes pass `slipmem check`, readable through surfaces | Pass (indirect) | `migration-import.test.ts` calls `checkNoteRoot(target)` and reads notes through the parser; CLI `migrate.test.ts` runs `check --json`; server/MCP tests prove valid roots are readable through their surfaces | There is no single automated test that imports and then calls CLI, MCP, and HTTP on that same root. The shared repository and separate surface tests make this low risk, but it is indirect. |
| MIGRATE-06 Legacy-only/malformed row reported; not dropped/truncated | Pass | `migration-import.test.ts` quarantine, missing-column table rows, bigint/blob preservation, valid+invalid mix; `migration-plan.test.ts` exact integers/blobs; independent probes now match after commits `752803a`, `efac3f2` | Text, blobs, bigints, and blank strings are preserved. Table-level rows without a raw row remain manifest issues only. A residual low issue is noted as G8. |

## 7. Security and quality (13.7)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| SEC-01 Traversal, separator injection, absolute paths, escaping symlinks rejected | Pass | `packages/core/src/markdown/repository.test.ts` traversal, symlinked note, symlinked root, backup symlink, size tests; `root.test.ts` env/ancestor/init symlink tests; `check-links.test.ts` path-injection links; `state-safety.test.ts`; commits `ef03812`, `c488657`, `6fd9ab3`, `b19f137` | Direct filesystem access is rejected before writes; link validation reports unsafe links without touching the filesystem. |
| SEC-02 Oversized files/content/queries/wiki bounded with actionable errors | Pass | `repository.test.ts` 1 MiB read test; schema content limits; `search-index.test.ts` query/result bound tests; `wiki.test.ts` excerpt/page/field bounds; MCP recall-bound regression `e176d6e`; approval queue/diff bounds | Fallback linear search applies the same query/result bounds. |
| SEC-03 Loopback default and documented non-loopback risk | Pass | `packages/server/src/config.test.ts` loopback/non-loopback/invalid-port tests; `packages/web/scripts/serve.ts`; README and operator guide | Non-loopback bind prints the unauthenticated/plaintext warning. |
| SEC-04 Note content not executed; web escapes untrusted HTML | Pass | `packages/web/src/main.test.ts` escaped-content and wiki-UI tests; browser XSS check 10 and review-diff XSS supplement; `wiki.test.ts` injection test; `check-links.test.ts` | The web UI uses text nodes, not trusted HTML. Wiki output treats notes as quoted data. |
| SEC-05 No automatic Git actions; conflict markers reported, not resolved | Pass | `checkNoteRoot` conflict-marker tests (`check-links.test.ts` "reports conflict markers and preserves every note byte-for-byte"); CLI check tests; operator guide recovery section; code search finds no `git commit`/`push`/`reset` execution | The browser and CLI probes left Git untouched. |
| SEC-06 `bun run check` passes (lint, typecheck, tests, web build) | Pass (provisional) | Run 3: `oxlint` clean, root/web typecheck clean, **341 pass / 0 fail / 2859 expect() calls**, Vite client and SSR build successful. Earlier red runs and focused reruns are recorded in section 0. | The green run includes uncommitted `packages/web/**` edits. Repeat the gate after those land; do not treat this as a frozen-tree release result. |

## 8. Definition of done (13.8)

The nine user steps are not identical to the labeled criteria above, so they are
tracked separately.

| Step | Status | Evidence | Notes |
| --- | --- | --- | --- |
| 1. Clone, install dependencies | Pending | README quickstart; `bun install`/`bun run check` documented | No clean-clone run is recorded at this snapshot. The repository itself is not fresh because other workers are mid-edit. |
| 2. `init`; create fleeting/permanent/literature | Pass | CLI `workflow.test.ts` "runs the local loop offline through the root script"; `init.test.ts`; `notes.test.ts`; browser checks 2-4 | Literature without a reference is rejected. |
| 3. Search and browse locally | Pass | CLI `search.test.ts`, `notes.test.ts`; web `main.test.ts`; browser checks 1, 8, 9 | Search refreshes the disposable index before reading. |
| 4. MCP capture fleeting, write literature, propose permanent | Pass | MCP `tools.test.ts` direct writes and pending permanent tests; `mcp-markdown.test.ts`; browser checks 13-14 | No note file for the permanent proposal until approval. |
| 5. Approve proposal from CLI or web | Pass | CLI `approval.test.ts`; server `app.test.ts` review test; browser checks 14-15 | Stale proposals fail closed. |
| 6. Open a cited topic page on demand | Pass | Core/CLI/MCP/server wiki tests; browser check 9 | Extractive default; synthesized opt-in is conservative. |
| 7. Delete cache, rebuild, identical content | Pass | `search-index.test.ts` delete/rebuild test; CLI `check --rebuild-index` test | Manual deletion and rebuild works. The separate **clear-cache command** required by §12 is missing (G1); this step does not require that command. |
| 8. Migrate SQLite with no data loss/source modification | Partial | Fixture and independent migration evidence; see MIGRATE-01/02 | No real representative production database has been committed and imported. Source preservation is well tested. |
| 9. Read notes in a text editor and commit to Git without slipmem Git actions | Pass | Flat Markdown files; browser check 22; SEC-05 | slipmem never runs `git add/commit/push/reset`; the user owns Git. |

## 9. Requirements outside section 13 that are still missing

These are **not** counted as §13 failures unless noted, but they are explicit
plan deliverables and should be tracked rather than silently treated as done.

| ID | Requirement | Status | Evidence / impact | Classification |
| --- | --- | --- | --- | --- |
| G1 | Provide a clear-cache command (plan §12, "Index") | **Missing** | `MarkdownSearchIndex.clear` exists in `packages/core/src/markdown/search-index.ts`, but `packages/cli/src/commands/` has no `cache` command. The operator guide's cache section and its known-gaps list say to remove the cache manually or use `check --rebuild-index`. | Hard MVP gap. The security table says "Provide a clear-cache command"; manual removal is not that command. It is not a §13 numbered criterion, but it is a release requirement. |
| G2 | Search index records backlinks as derived data (plan §5.6, §6.1) | **Missing** | `packages/core/src/markdown/check.ts` derives backlinks for `NoteCheckReport.links.backlinks` (`check-links.test.ts`). `search-index.ts` has no backlink table/API; `docs/mvp-link-check-evidence.md` §4 records this as remaining work. | Plan contract gap. Not in §13, and no current MCP/web consumer requires persisted backlinks, so it is not a demonstrated user blocker. Either add the derived table/API or amend the plan to say backlinks are check-time only. |
| G3 | Migration defaults to the current DB path and `SLIPMEM_DB_PATH` (Phase 5) | **Missing** | `packages/cli/src/commands/migrate.ts` calls `requireStringOption(parsed, "db", ...)`; `--db` is mandatory. `packages/server/src/config.ts` still has `resolveDatabasePath()` but the CLI never uses it. | Phase 5 deliverable gap. MIGRATE-01 can pass with an explicit `--db`; automatic default resolution is absent. |
| G4 | Read-only compatibility path for the old SQLite DB for one release (Phase 5) | **Missing** | `packages/server/src/database.ts` still builds a writable Drizzle layer and runs migrations; it is exported and used only by `migrations.test.ts`. No server/CLI/MCP/web route opens the old DB read-only. The untouched SQLite file is an archive, not a compatibility path. | Phase 5 deliverable gap. TRUTH-04 is still satisfied because Markdown is the only runtime source. Decide whether the one-release read-only path is required for the MVP or explicitly drop it in the plan. |
| G5 | Migration fixtures match a real migrated production database | **Partial** | `packages/core/fixtures/phase0/migration/current.sql` is hand-written; it currently matches `packages/server/drizzle/20261114044257_init/migration.sql`, but tests read the fixture, never run the runtime migrations to create the source. | Evidence gap for MIGRATE-01, not a known data-loss bug. Add a test that creates a DB through the real migration path, inserts rows, and imports it, or commit a sanitized real DB fixture. |
| G6 | Synthesized wiki semantic validity and sandbox proof | Conservative, not missing | `packages/core/src/wiki/synthesis.ts` validates exact extractive support; it does not prove entailment. `sandbox.ts` probes bubblewrap and fails closed; unsafe opt-in is documented. Tests in `wiki.test.ts` cover opposite claims, paraphrase rejection, argv/stdin separation, and secret-free env. | Deliberate narrower implementation. §13.5/§9 require a citation validator for unsupported sentences, not semantic entailment. Do not describe it as semantic validation. A host without a working bubblewrap cannot run agent synthesis without the explicit unsafe opt-in. |
| G7 | Browser acceptance defects D1-D4 | Pending web fixes | `/tmp/opencode/browser-acceptance/REPORT.md`: D1 topic counts include fleeting while cited pages exclude them; D2 health count stale; D3 duplicated service name; D4 synthesized CTA returns 501 when unconfigured. All are Low/Trivial, not blockers. Uncommitted web edits at this snapshot add per-type topic counts, health refresh/label changes, and a synthesis capability gate; do not mark them fixed until those edits land and the browser run is repeated. | UX/doc polish, not an acceptance blocker. D4 overlaps G6's conservative synthesis behavior. |
| G8 | Residual migration low-severity reporting issues | Pending verification | The independent migration log's item 7 included a duplicate-`legacyId`-across-tables warning that imports both rows once but reports a permanent `skipped-conflict` on every merge. The post-audit fixes address exact integers, live locks, WAL planning, `.state` symlinks, interrupted runs, skipped paths, table-shaped quarantine, and false success; this duplicate warning is not named in the fix summary. | Low. Verify against current `migration-import.ts` and either fix or document before release. Not a data-loss issue in the tested case. |
| G9 | Prior SQLite-first docs marked superseded (plan §15) | Not applicable / unverified | The repository currently contains only the MVP plan, evidence notes, operator guide, and Markdown READMEs. No prior SQLite-first document remains to mark, and no `superseded` marker was added. | If older docs exist outside this checkout, mark them when imported. Do not claim a docs migration that has no file to point at. |

## 10. What can be claimed now

Supported by committed tests or named independent runs:

- Flat `.slipmem/` storage, safe parsing, atomic writes, collision suffixes,
  unknown-key preservation, and disposable-index recovery.
- CLI, MCP (stdio + HTTP), and web/API parity on IDs, bounds, and shared
  Markdown services.
- Approval policy, pending permanent/deletes, direct fleeting/literature writes,
  no MCP approval tool, and under-lock stale-base protection.
- Extractive cited wiki, empty/conflict handling, injection-as-data, explicit
  `--out`, and a fail-closed conservative synthesized mode.
- Migration source preservation, backup, dry run, merge idempotence, malformed
  row quarantine, exact bigints/blobs, WAL handling, symlink-safe state, and
  interrupted-run recovery on the committed fixtures.
- A clean full gate on the current working tree: lint, typecheck, 341 tests,
  and the client/SSR web build.

Not claimable yet:

- A final gate on the landed tree (the green run included uncommitted web
  edits) or a clean-clone release run.
- A real representative SQLite database import (MIGRATE-01).
- A `clear-cache` command (G1), index-recorded backlinks (G2), migration default
  source resolution (G3), or a read-only old-DB compatibility path (G4).
- Semantic validation of synthesized prose (G6); only exact extractive support
  is proven.
- That browser defects D1-D4 are fixed (G7).

The outstanding items are bounded. None of the committed evidence shows note
data loss or a broken approval boundary. The release decision should wait for
the web edit to land, a repeat full check on that landed tree, a clean-clone run,
and an explicit decision on G1/G3/G4.
