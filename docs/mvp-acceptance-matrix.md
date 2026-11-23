# MVP acceptance matrix

Date: 2026-11-18
Authority: [`docs/mvp-plan.md`](./mvp-plan.md) section 13.
Evidence snapshots: `29b7dd1` through `2cdf077`. The release gate was run in a
clean clone of `d1f3565`; every later commit, including `2cdf077` which adds the
final-check note, is documentation only. The last source-bearing commits are
`8af9e27` (approval index refresh) and `24a5c39` (bounded integration test
timeouts); `git diff d1f3565..2cdf077 -- packages scripts` is empty. Earlier
focused runs at `56d009c` are retained as historical checkpoints below.

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

Snapshot head: `2cdf077` (documentation only). Verified source head: `d1f3565`,
tree `551b740ee00335ae2878543e2bdf08e08c43905b`, `bun.lock` SHA-256
`4295f55f0b9dd17c2c2dddac577fbaae128f9b29efc6fb35195482a5557c0f7c`, Bun
`1.4.4`. The full gate and the new-user loop were captured in a clean clone of
`d1f3565`, not in the shared working tree; the decisive evidence is
[`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md).

Full gate status:

- **Pass.** `git clone --no-local`, `bun install --frozen-lockfile`, then
  `bun run check` at `d1f3565`: oxlint clean, root and `packages/web`
  typecheck clean, `bun test` **382 pass, 1 skip, 0 fail, 3287 expect() calls,
  383 tests across 45 files in 138.58 s**, Vite client and SSR build
  successful, `bun run check` exit 0 in 148.83 s.
- This is **not** "383 passed". The one skip is
  `scripts/tour/record.test.mjs`, which selects `test.skip` when `playwright`
  or its Chromium binary is absent; the clean clone has neither. The product
  tour was recorded separately with Playwright 1.64.1/Chromium 1248, and its
  suite recorded **20 pass, 0 fail, 66 expect() calls across 2 files**. The
  recording, not the clean clone, is the hydrated-browser evidence.
- No test failed or flaked, and no test timeout override was used. Install left
  one mode-only difference on `packages/mcp/src/main.ts` (content hash
  unchanged, `git diff` shows only `100644` -> `100755` because Bun links the
  workspace `bin`); that is a checkout-hygiene caveat, not a source change.
- Offline isolation was **not** enforced: `unshare -n` is denied in this
  environment. Install used the local Bun cache (61 packages in under 1 s), and
  the CLI/MCP/web loop made no observed external calls, but this gate does not
  prove network isolation.

The clean-clone new-user loop, cache recovery, read-only legacy view, migration
of an actual local database, web API, and HTTP/stdio MCP checks are recorded in
[`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md) sections
2-5. That source database is the real local default database with three test
notes, one per type; all three imported with the source bytes and hash
unchanged. It is not a sanitized production dump or a real-user corpus.

Historical focused runs executed at `56d009c` (superseded for the gate by the
clean-clone run, retained as commit-local checkpoints):

```text
$ bun test packages/core/src/migration
41 pass, 0 fail, 547 expect() calls, 4 files

$ bun test packages/core/src/markdown/search-index.test.ts packages/cli/src/cache.test.ts
22 pass, 0 fail, 124 expect() calls, 2 files

$ bun test packages/cli
52 pass, 0 fail, 453 expect() calls, 14 files

$ bun test packages/cli/src/legacy.test.ts
3 pass, 0 fail, 35 expect() calls, 1 file

$ bun test packages/core/src/wiki
33 pass, 0 fail, 237 expect() calls, 2 files
```

Documentation check for this update: every relative Markdown link under `docs/`
resolves except four intentional broken-link examples in
[`docs/mvp-link-check-evidence.md`](./mvp-link-check-evidence.md)
(`20261117193045-note.md`, its anchor form, `diagram.png`, and `missing.md`).
Those are fixtures for the link checker, not documentation defects.

Independent runs incorporated:

- Final independent clean-clone release check at `d1f3565`:
  [`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md). Clean
  clone, frozen install, full gate, new-user local loop with isolated XDG
  roots, cache recovery, read-only legacy view, migration of the real local
  three-row database with source bytes unchanged, web API and MCP checks,
  approval-index refresh, and the fail-closed synthesis sandbox path.
- Product tour recording, 2026-11-18 00:51-00:53 UTC at `e408e47`:
  [`docs/mvp-product-tour-evidence.md`](./mvp-product-tour-evidence.md). Final
  MP4 `scripts/tour/output/slipmem-product-tour.mp4`, SHA-256
  `a429e44bf936f0f4f0ed394e0af8f3642f1338ab9863fa33536ab5f4d7cb96a0`,
  3,018,971 bytes, H.264 1440x900, 25 fps, 107.96 s, no audio stream, captions
  burned in. Six real notes, a real HTTP MCP proposal approved in the browser,
  scenario postconditions verified. Tour suite **20 pass, 0 fail, 66 expect()
  calls**. The recording source predates the later source commits `8af9e27`
  (approval index refresh) and `24a5c39` (test timeouts) and was not rerendered
  at `d1f3565`.
- Browser acceptance, final polish at `b6f3cfe`:
  `/tmp/opencode/browser-final-polish/REPORT.md`. Production bundle, isolated
  XDG roots, hydrated UI. **21/21** browser checks, **36 pass / 0 fail / 177
  expect() calls** in the focused server/web suites at the exact target commit,
  and zero normal-flow console, page, request, or HTTP errors. The four prior
  findings D1-D4 are fixed. `git diff b6f3cfe..e408e47 -- packages/web/src
  packages/server/src/api.ts` is empty; later source commit `8af9e27` changes
  the approval/index wiring in `packages/server/src/markdown.ts` and adds an
  `index` field to approval responses in `packages/server/src/api.ts`, so the
  API at the release head is proven by the final-check HTTP checks rather than
  by that unchanged-range claim.
- Browser acceptance, first run, 2026-11-17/18:
  `/tmp/opencode/browser-acceptance/REPORT.md`. **25/25** checks and **2/2**
  supplemental XSS checks. Superseded for D1-D4 by the final-polish report.
- Migration adversarial verification, 2026-11-17/18:
  `/tmp/opencode/mig/EVIDENCE.md`, plus the independent recheck
  `/tmp/opencode/mig2/RESULTS.md`. All seven recheck acceptance areas pass with
  no data-loss finding. The recheck's low reporting caveats were addressed in
  `c1f3bf1` and documented in
  [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md)
  section 4; the synchronous-import heartbeat limitation is documented rather
  than claimed as protection.
- Real startup migration source and legacy bootstrap:
  [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md)
  sections 1 and 5. `41 pass, 0 fail, 547 expect() calls`, including a source
  database created through `makeDatabaseLayer`/`runMigrations` and real note
  services.
- Copy-only recovery smoke, earlier draft:
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
| TRUTH-01 Delete index, rebuild, same IDs/list/search | Pass | `packages/core/src/markdown/search-index.test.ts` "deleting the index and rebuilding returns the same IDs and search results" and the backlink cache-loss test; CLI `search.test.ts` "checks a clean root, reports errors, and rebuilds the index"; commits `13340eb`, `77f4175` | The index remains disposable; `check --rebuild-index` and `cache clear` are the documented recovery paths. Derived backlink identities are rebuilt from note files too. |
| TRUTH-02 Only `.slipmem/*.md` starts CLI, MCP, and web | Pass (manual probe) | `/tmp/opencode/truth02-smoke.ts` + `.log`; existing surface tests: `packages/mcp/src/main.test.ts` "stdio tool calls read the same disposable Markdown root", `packages/server/src/app.test.ts` "files written by another surface are visible without restart" | The manual probe copied only note files into a fresh root and exercised CLI, API, and stdio MCP. There is no committed test that specifically starts all three from a note-only copy; add one if this clause needs permanent regression coverage. |
| TRUTH-03 External editor edit visible after refresh | Pass | `packages/core/src/markdown/search-index.test.ts` "refreshes an externally edited file and removes deleted files" and "refreshes an external edit that preserves size and mtime"; MCP `tools.test.ts` "search sees an external markdown edit after refresh"; commit `a2a6009` | Refresh compares the SHA-256 content hash, not only size/mtime. |
| TRUTH-04 No runtime path requires SQLite note tables after cutover | Pass | `packages/server/src/markdown.ts` and `packages/server/src/app.ts` build the Markdown layer; `packages/web/src/entry.server.ts` mounts it; MCP `layer.ts` and CLI `context.ts` use the repository; `packages/server/src/database.ts` is exported only for the migration/compatibility window and is used by `migrations.test.ts` | `resolveDatabasePath()` creates a parent directory if called, but no HTTP/CLI/MCP/web startup path calls it. The old SQLite file is not a runtime source of truth. |

## 3. CLI, MCP, and web parity (13.3)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| SURFACE-01 CLI note immediately readable by MCP and web | Pass | `packages/server/src/app.test.ts` "files written by another surface are visible without restart"; MCP `tools.test.ts` external-edit test; `packages/cli/src/wrappers.test.ts` "web serves the note root resolved outside the repository"; commit `057c83f`; browser report check 12 (external CLI note visible after navigation); `/tmp/opencode/truth02-smoke.ts` | Browser check 12 used the real CLI and hydrated UI. The wrapper test launches the real entry point from outside the checkout. |
| SURFACE-02 stdio and HTTP MCP expose same names/schemas/limits/shapes | Pass | `packages/server/src/mcp-markdown.test.ts` "HTTP MCP uses the same Markdown registrations and approval policy as stdio"; `packages/mcp/src/main.test.ts` stdio initialize/tools; commits `91e18f6`, `e176d6e` | Both transports consume `McpNoteRegistrations` and `makeMarkdownServicesLayer`; the HTTP test also checks no approve/reject/apply tool. |
| SURFACE-03 Web list/search/topics show all three types, no type folders | Pass | `packages/web/src/main.test.ts` list/search/topics view tests; final-polish browser report checks for all-type counts, per-type breakdown, and the fleeting toggle; server `app.test.ts` search/topics test; commit `b6f3cfe` | The earlier fleeting-count inconsistency (D1) is fixed in the production bundle and verified with a hydrated browser. No type folder was observed. |
| SURFACE-04 Web API uses stable note IDs, not array positions or SQLite ids | Pass | `packages/server/src/app.test.ts` "canonical ID routes create, read, update, list, and delete flat Markdown notes"; `packages/web/src/main.test.ts` ID-based detail/delete tests; commit `7a1b677` | IDs are filename stems. |
| SURFACE-05 Type route compatibility resolves through the same repository, no new layout | Pass | `packages/server/src/app.test.ts` "legacy type routes are thin adapters over the same ID repository"; browser check 22; commit `7a1b677` | A note fetched through the wrong type route returns 404; adapters create no folders. |

## 4. Approval (13.4)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| APPROVE-01 MCP permanent create/update is pending; no file change | Pass | `packages/core/src/approval/approval.test.ts` "MCP permanent create stays pending, reviews, and applies atomically"; "permanent update and reclassification are pending; rejection changes nothing"; MCP `tools.test.ts` permanent-create and stale-update tests | Pending creates reserve an ID but write no note. |
| APPROVE-02 MCP literature create/update writes directly with `source: mcp` | Pass | `packages/mcp/src/tools.test.ts` "fleeting and literature writes are direct and carry mcp provenance" (creates both types with no pending record, updates a fleeting note directly, and asserts stored `source: mcp` plus the literature reference); `packages/core/src/approval/approval.test.ts` "implements the frozen MCP matrix and fails closed on unknown env"; commit `1bd37b4` | Reference is still required by the shared schema. The public MCP test exercises direct create for both types and a direct fleeting update; the frozen policy matrix covers the non-permanent direct path. |
| APPROVE-03 MCP delete of any note is pending; nothing deleted | Pass | `packages/mcp/src/tools.test.ts` "every MCP delete is pending and leaves the note in place" (asserts the pending proposal and the surviving note); `packages/cli/src/approval.test.ts` "applies a delete proposal through the repository backup path" (asserts the trash backup and the missing note after approval); commit `88035a8` | Applies through the repository backup move, not unlink. |
| APPROVE-04 `slipmem approve` applies atomically; visible to CLI/MCP/web | Pass | CLI `approval.test.ts` "reviews a pending permanent proposal and applies it atomically"; server `app.test.ts` "pending human review exposes a diff and approves or rejects without MCP approval"; browser report checks 14-15 | Browser check 15 confirmed CLI and web visibility after approval; MCP reads the same repository. |
| APPROVE-05 `slipmem reject` leaves notes unchanged | Pass | CLI `approval.test.ts` "reject removes the proposal without creating or changing a note"; core rejection test; browser check 16 | Reject deletes only the proposal record. |
| APPROVE-06 Stale base hash rejected without overwriting | Pass | `approval.test.ts` stale update/delete tests and under-lock CAS interleaving tests; CLI `approval.test.ts` stale test; MCP stale-update test; commits `f6641c5`, plus `cef9d19` | Repository re-reads and compares the hash inside `withRepositoryLock`; the pre-check is descriptive only. |
| APPROVE-07 No MCP tool can approve/reject | Pass | MCP `tools.test.ts` "exposes the bounded read surface" asserts no approve/reject/apply names; "the MCP process receives only the submitMcp approval capability"; `mcp-markdown.test.ts`; commit `3c36f7e` | The capability is projected at runtime and in types. |
| APPROVE-08 MCP fleeting create/update direct with `source: mcp` | Pass | `packages/mcp/src/tools.test.ts` "fleeting and literature writes are direct and carry mcp provenance"; `packages/core/src/approval/approval.test.ts` "implements the frozen MCP matrix and fails closed on unknown env" | Policy is fail-closed for unknown env values. |
| APPROVE-09 Pending proposals never appear in notes/lists/search/topics/wiki or `.slipmem/*.md` | Pass | `packages/core/src/approval/approval.test.ts` "MCP permanent create stays pending, reviews, and applies atomically" (asserts no note file and one pending record before approval); `packages/mcp/src/tools.test.ts` "permanent creates are pending, write no note, and can only be applied by a human service" and "every MCP delete is pending and leaves the note in place" | Proposal records live under `.state/pending/`; they are not scanned as notes. No dedicated wiki-leak test exists, but the wiki selector consumes repository notes only. |

## 5. Topic wiki (13.5)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| WIKI-01 Bounded topic selection only | Pass | `packages/core/src/wiki/wiki.test.ts` topic-first selection, default fleeting exclusion, explicit inclusion, title fallback, limit tests; CLI `wiki.test.ts`; MCP `tools.test.ts` wiki test; commit `465ac9e` | Default 10, hard maximum 25; exact topic matches rank first. No semantic/vector ranking. |
| WIKI-02 Every factual excerpt/sentence has adjacent ID and file citation | Pass | `wiki.test.ts` cited sections and structured-field bounds; `render.ts`; CLI wiki test; browser check 9 | Bounding drops whole trailing sections/citations rather than cutting a citation mid-line. |
| WIKI-03 Empty topic invents nothing | Pass | `wiki.test.ts` "returns an empty cited-free page and suggestions when nothing matches"; CLI `wiki.test.ts` empty-topic test | Empty result plus bounded suggestions. |
| WIKI-04 Conflicts stay separate with citations | Pass | `wiki.test.ts` "keeps conflicting notes in separate cited sections" | No merge into an unattributed claim. |
| WIKI-05 Wiki writes nothing under `.slipmem/` unless explicit outside output | Pass | `wiki.test.ts` "treats injection text as quoted data and writes nothing"; CLI `wiki.test.ts` `--out` inside/outside and symlinked-parent tests; browser check 9 | CLI `--out` resolves the parent's real path and rejects the note root. |
| WIKI-06 Note text is data; embedded instructions not followed | Pass | `wiki.test.ts` injection test; sandbox/argv tests; MCP instructions test; browser XSS checks | Extractive mode quotes text. Synthesized mode sends bounded JSON on stdin; no note text enters argv or environment. |
| WIKI-07 Configured synthesizer produces a cited page; validator drops unsupported output | Pass (conservative) | `synthesis.test.ts` and `wiki.test.ts` full-paragraph fixture process; public wiki service tests "omits concrete ellipsis, parenthetical, and abbreviation clips" and "accepts a full paragraph wrapped across Markdown lines"; multi-sentence extraction, paraphrase, opposite-claim, empty-output, sandbox, secret-env, unregistered-model, and malformed-output tests; CLI `wiki.test.ts` agent tests; commits `cef9d19`, `df90921`, `4164078`, `c6d61c1`, `05d5191` | The validator requires an **exact complete source paragraph/block** in both `text` and `quote`; it does not segment sentences and does not accept a free-form sentence even when it is a real substring. This is stricter than the literal §13.5 sentence requirement, but it is not semantic entailment or factual verification. Long multi-sentence paragraphs over the 500-character item bound are omitted rather than clipped. Sandbox default is fail-closed bubblewrap; the unsafe no-sandbox opt-in is documented. No hosted model adapter ships; `--model` fails closed unless the embedding app registers the exact ID. |

## 6. Migration (13.6)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| MIGRATE-01 Representative current DB imports with fields preserved | Pass (conservative) | `packages/core/src/migration/migration-current-database.test.ts` creates the source through `makeDatabaseLayer`/`runMigrations` and real note services, then asserts every mapped field, provenance, timestamp, rendered hash, and source immutability; `migration-import.test.ts` current and legacy bootstrap fixtures; CLI `migrate.test.ts`; independent `/tmp/opencode/mig/EVIDENCE.md` and `/tmp/opencode/mig2/RESULTS.md`; final check migrated the real local default database (32,768 B, SHA-256 `31278cde...`, three rows, one per type) at `d1f3565` with source unchanged | The source is a real startup-created database with one note of each type, a real update, the frozen legacy bootstrap shape, and the actual local three-row database, not a sanitized production dump. No user-data/production corpus was available or committed. See gap G5, which is narrowed rather than open. |
| MIGRATE-02 Source unchanged; backup created | Pass | `migration-import.test.ts` current fixture source-unchanged + backup integrity/table counts; WAL backup test; CLI `migrate.test.ts` SHA assertion; independent WAL and backup probes | Backup is `VACUUM INTO` under `.state/migrations/<run>/source-backup.db`, then opened read-only and integrity-checked. |
| MIGRATE-03 Dry run writes no notes; reports counts/collisions/invalid rows | Pass | `migration-import.test.ts` "a dry run reports the plan without writing anything" and WAL dry-run test; CLI `migrate.test.ts` dry-run test | Planning reads a private snapshot of the DB and `-wal`/`-journal`, so it does not create `-shm` beside the source. |
| MIGRATE-04 Merge rerun does not duplicate | Pass | `migration-import.test.ts` merge idempotence, merge collision, and interrupted-run recovery tests; CLI merge test; commits `f4a4b76`, `5fbfc05` | Skips by `legacyId`, reports actual existing paths, and marks dead-owner `running` manifests `interrupted`. |
| MIGRATE-05 Imported notes pass `slipmem check`, readable through surfaces | Pass (indirect) | `migration-import.test.ts` calls `checkNoteRoot(target)` and reads notes through the parser; CLI `migrate.test.ts` runs `check --json`; server/MCP tests prove valid roots are readable through their surfaces | There is no single automated test that imports and then calls CLI, MCP, and HTTP on that same root. The shared repository and separate surface tests make this low risk, but it is indirect. |
| MIGRATE-06 Legacy-only/malformed row reported; not dropped/truncated | Pass | `migration-import.test.ts` quarantine, missing-column table rows, bigint/blob preservation, valid+invalid mix, and cross-type duplicate IDs; `migration-plan.test.ts` exact integers/blobs; independent probes match after commits `752803a`, `efac3f2`, `c1f3bf1` | Text, blobs, bigints, and blank strings are preserved. Table-level rows without a raw row remain manifest issues only. The duplicate-legacy-ID reporting issue is closed as G8. |

## 7. Security and quality (13.7)

| Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- |
| SEC-01 Traversal, separator injection, absolute paths, escaping symlinks rejected | Pass | `packages/core/src/markdown/repository.test.ts` traversal, symlinked note, symlinked root, backup symlink, size tests; `root.test.ts` env/ancestor/init symlink tests; `check-links.test.ts` path-injection links; `state-safety.test.ts`; commits `ef03812`, `c488657`, `6fd9ab3`, `b19f137` | Direct filesystem access is rejected before writes; link validation reports unsafe links without touching the filesystem. |
| SEC-02 Oversized files/content/queries/wiki bounded with actionable errors | Pass | `repository.test.ts` 1 MiB read test; schema content limits; `search-index.test.ts` query/result bound tests; `wiki.test.ts` excerpt/page/field bounds; MCP recall-bound regression `e176d6e`; approval queue/diff bounds | Fallback linear search applies the same query/result bounds. |
| SEC-03 Loopback default and documented non-loopback risk | Pass | `packages/server/src/config.test.ts` loopback/non-loopback/invalid-port tests; `packages/web/scripts/serve.ts`; README and operator guide | Non-loopback bind prints the unauthenticated/plaintext warning. |
| SEC-04 Note content not executed; web escapes untrusted HTML | Pass | `packages/web/src/main.test.ts` escaped-content and wiki-UI tests; browser XSS check 10 and review-diff XSS supplement; `wiki.test.ts` injection test; `check-links.test.ts` | The web UI uses text nodes, not trusted HTML. Wiki output treats notes as quoted data. |
| SEC-05 No automatic Git actions; conflict markers reported, not resolved | Pass | `checkNoteRoot` conflict-marker tests (`check-links.test.ts` "reports conflict markers and preserves every note byte-for-byte"); CLI check tests; operator guide recovery section; code search finds no `git commit`/`push`/`reset` execution | The browser and CLI probes left Git untouched. |
| SEC-06 `bun run check` passes (lint, typecheck, tests, web build) | Pass | Clean clone of `d1f3565`: `bun install --frozen-lockfile` exit 0 (61 packages); oxlint clean; root and web typecheck clean; `bun test` **382 pass, 1 skip, 0 fail, 3287 expect() calls, 383 tests across 45 files in 138.58 s**; Vite client and SSR build successful; `bun run check` exit 0 in 148.83 s. [`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md) sections 1 and 7. | The single skip is the Playwright-gated `scripts/tour/record.test.mjs` in a clone without Playwright; it is not a failure and this is not a 383-passed run. Source at `d1f3565` includes `8af9e27` and `24a5c39`; later commits through `2cdf077` are docs-only. Offline network isolation was not proven. |

## 8. Definition of done (13.8)

The nine user steps are not identical to the labeled criteria above, so they are
tracked separately.

| Step | Status | Evidence | Notes |
| --- | --- | --- | --- |
| 1. Clone, install dependencies | Pass | Clean clone of `d1f3565` with `bun install --frozen-lockfile` exit 0 (61 packages), followed by a full `bun run check` exit 0; [`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md) sections 1-2 | Install leaves a mode-only bit on `packages/mcp/src/main.ts` (content unchanged); the clone is otherwise clean. Offline install was not enforced. |
| 2. `init`; create fleeting/permanent/literature | Pass | CLI `workflow.test.ts` "runs the local loop offline through the root script"; `init.test.ts`; `notes.test.ts`; browser checks 2-4 | Literature without a reference is rejected. |
| 3. Search and browse locally | Pass | CLI `search.test.ts`, `notes.test.ts`; web `main.test.ts`; browser checks 1, 8, 9 | Search refreshes the disposable index before reading. |
| 4. MCP capture fleeting, write literature, propose permanent | Pass | MCP `tools.test.ts` direct writes and pending permanent tests; `mcp-markdown.test.ts`; browser checks 13-14 | No note file for the permanent proposal until approval. |
| 5. Approve proposal from CLI or web | Pass | CLI `approval.test.ts`; server `app.test.ts` review test; browser checks 14-15 | Stale proposals fail closed. |
| 6. Open a cited topic page on demand | Pass | Core/CLI/MCP/server wiki tests; browser check 9 | Extractive default; synthesized opt-in is conservative. |
| 7. Delete cache, rebuild, identical content | Pass | `search-index.test.ts` delete/rebuild and backlink cache-loss tests; CLI `check --rebuild-index` test; `packages/cli/src/cache.test.ts`; commits `13340eb`, `77f4175`, `5002d7b` | Manual deletion, `check --rebuild-index`, and the landed `slipmem cache clear` command rebuild the same note and backlink identities from files. |
| 8. Migrate SQLite with no data loss/source modification | Pass (conservative) | Real local three-row database migrated at `d1f3565` with source SHA-256 unchanged and identical bytes; real-startup-created and legacy bootstrap import tests; independent migration evidence; see MIGRATE-01/02/06 and [`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md) section 3 | Source preservation, field mapping, merge recovery, WAL, crash, and malformed-row handling are tested. The source is a real startup-created local database with one MCP test note per type, not a sanitized production dump or user corpus. |
| 9. Read notes in a text editor and commit to Git without slipmem Git actions | Pass | Flat Markdown files; browser check 22; SEC-05 | slipmem never runs `git add/commit/push/reset`; the user owns Git. |

## 9. Requirements outside section 13 that are tracked

These are **not** counted as §13 failures unless noted, but they are explicit
plan deliverables and should be tracked rather than silently treated as done.
Gap statuses use **Closed** (landed and tested at this snapshot), **In progress**
(part landed, surface incomplete), **Narrowed** (the deliverable is met with
documented narrower evidence), or **Conservative** (deliberate narrower
behavior).

| ID | Requirement | Status | Evidence / impact | Classification |
| --- | --- | --- | --- | --- |
| G1 | Provide a clear-cache command (plan §12, "Index") | **Closed** | `packages/cli/src/commands/cache.ts` and `packages/cli/src/cache.test.ts`; registered in `packages/cli/src/cli.ts`; commit `5002d7b`. Focused `bun test packages/core/src/markdown/search-index.test.ts packages/cli/src/cache.test.ts` and the full CLI suite pass at `56d009c`. | `slipmem cache clear` deletes only derived index rows through `MarkdownSearchIndex.clear`; notes and local state are untouched. `check --rebuild-index` and manual cache removal remain documented fallbacks. |
| G2 | Search index records backlinks as derived data (plan §5.6, §6.1) | **Closed** | `packages/core/src/markdown/search-index.ts` schema version 2 with a derived `links` table and bounded `backlinks(noteId, limit)` API; `search-index.test.ts` persistence/bounds, external-refresh, cache-loss, and linear-fallback tests; commit `77f4175`; [`docs/mvp-backlink-index-evidence.md`](./mvp-backlink-index-evidence.md). | Backlinks are cache-only derived data rebuilt from Markdown; note files remain the authority. No CLI/MCP/web consumer is required for the plan contract. |
| G3 | Migration defaults to the current DB path and `SLIPMEM_DB_PATH` (Phase 5) | **Closed** | `packages/cli/src/database-path.ts` plus `packages/cli/src/commands/migrate.ts`; resolution order is explicit `--db`, `SLIPMEM_DB_PATH`, then `$XDG_DATA_HOME/slipmem/slipmem.db`; commits `043de62`, `9d299fe`; `migrate.test.ts` "resolves the migration source from --db, SLIPMEM_DB_PATH, then XDG data". | An explicitly empty `--db` is rejected instead of silently falling back. The resolved path matches `packages/server/src/config.ts`. |
| G4 | Read-only compatibility path for the old SQLite DB for one release (Phase 5) | **Closed** | Read-only core API `getLegacyNote`/`listLegacyNotes` in `packages/core/src/migration/legacy-read.ts`, exported from `@slipmem/core`; commits `f6627a4`, `e1b7192`. User-facing `slipmem legacy list` / `legacy show` in `packages/cli/src/commands/legacy.ts`, with bounded list/show, one-release warning, default source resolution, and tests in `packages/cli/src/legacy.test.ts`; commit `56d009c`; [`docs/mvp-cli-evidence.md`](./mvp-cli-evidence.md). The core API is described in [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md) section 2; that note predates the CLI command. | Both surfaces are explicit read-only opt-ins and are not CLI/MCP/web/server startup behavior, so `.slipmem/*.md` remains the only runtime source. The CLI never imports, repairs, or writes. `bun test packages/cli/src/legacy.test.ts` -> 3 pass. |
| G5 | Migration fixtures match a real migrated production database | **Closed, narrowed** | `packages/core/src/migration/migration-current-database.test.ts` creates the source with `makeDatabaseLayer`/`runMigrations` and writes through the real note services, then imports and verifies every field and source hash; second test adopts the legacy bootstrap fixture; commit `c4e7aff`. `bun test packages/core/src/migration` -> `41 pass, 0 fail, 547 expect() calls`. | The source is real startup-created, not a sanitized production dump. The final check also migrated the actual local default database (three test notes, one per type) at `d1f3565` without mutating its bytes. No user-data/production corpus was available or committed; do not claim real-user-data coverage. The original "hand-written SQL only" limitation is gone. |
| G6 | Synthesized wiki semantic validity and sandbox proof | **Conservative** | `packages/core/src/wiki/synthesis.ts` validates an exact complete source paragraph/block in both `text` and `quote`; it does not segment sentences and does not prove entailment. `sandbox.ts` probes bubblewrap and fails closed; unsafe opt-in is documented. Tests cover full-paragraph acceptance, single-sentence rejection, paraphrase/opposite/clipped cases, argv/stdin separation, and secret-free env; commits `c6d61c1`, `05d5191`. | §13.5/§9 require a citation validator for unsupported sentences, not semantic entailment. The whole-paragraph rule is stricter than the sentence clause, but it is not semantic validation. Do not describe it as verifying truth. |
| G7 | Browser acceptance defects D1-D4 | **Closed** | `/tmp/opencode/browser-final-polish/REPORT.md`: **21/21** browser checks and **36 pass / 0 fail / 177 expect() calls** at exact commit `b6f3cfe`, production bundle, hydrated UI. D1 per-type topic counts and fleeting toggle, D2 health refresh/label, D3 single service name, and D4 unconfigured synthesis gate are verified. | All four findings were Low/Trivial. `git diff b6f3cfe..e408e47 -- packages/web/src packages/server/src/api.ts` is empty; later source commit `8af9e27` changed approval/index wiring in `packages/server/src/markdown.ts` and `api.ts`, and the final check at `d1f3565` re-exercised the web API and HTTP MCP after that change. |
| G8 | Residual migration low-severity reporting issues | **Closed** | `packages/core/src/migration/migration-import.ts` keys merge identity by `(type, legacyId)`; `migration-import.test.ts` "merge keeps the same legacyId distinct across note types" asserts two first-import notes, zero writes and two `skipped-legacy-id` on merge, zero effective collisions, no `legacy-id-conflict`, unchanged files. Checkpointed manifests, target-derived recovery counts, no rounded structured provenance copy, and PID-start reuse handling landed in `c1f3bf1`; documented in [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md) sections 3-4. | Cross-type duplicate IDs are now idempotent and stable. The synchronous-import heartbeat limitation remains documented in section 4.3 of the evidence note; ownership checks, not heartbeat age, protect the lock. |
| G9 | Prior SQLite-first docs marked superseded (plan §15) | Not applicable / unverified | The repository currently contains only the MVP plan, evidence notes, operator guide, and Markdown READMEs. No prior SQLite-first document remains to mark, and no `superseded` marker was added. | If older docs exist outside this checkout, mark them when imported. Do not claim a docs migration that has no file to point at. |

## 10. What can be claimed now

Supported by committed tests or named independent runs:

- Flat `.slipmem/` storage, safe parsing, atomic writes, collision suffixes,
  unknown-key preservation, and disposable-index recovery, including derived
  backlinks rebuilt from note files.
- CLI, MCP (stdio + HTTP), and web/API parity on IDs, bounds, and shared
  Markdown services.
- Approval policy, pending permanent/deletes, direct fleeting/literature writes,
  no MCP approval tool, and under-lock stale-base protection.
- Extractive cited wiki, empty/conflict handling, injection-as-data, explicit
  `--out`, and a fail-closed conservative synthesized mode with exact
  whole-paragraph support checking.
- Migration source preservation, backup, dry run, merge idempotence including
  cross-type duplicate IDs, malformed-row quarantine, exact bigints/blobs, WAL
  handling, symlink-safe state, and interrupted-run recovery on real
  startup-created and frozen bootstrap sources.
- `slipmem cache clear` (G1) and migration source default resolution
  (`--db`, `SLIPMEM_DB_PATH`, XDG data; G3).
- The read-only legacy database path (G4): the core API and the bounded,
  warning-first `slipmem legacy list/show` commands. Both are explicit opt-ins
  and neither is startup behavior.
- Browser findings D1-D4 fixed at `b6f3cfe` (G7), with the web/API behavior at
  the release head re-checked through HTTP and MCP at `d1f3565`.
- A clean-clone full gate and new-user local loop at `d1f3565`: `bun run check`
  exit 0 with 382 pass, 1 conditional Playwright skip, 0 fail, oxlint and both
  typechecks clean, and the Vite client/SSR build successful.
- Migration of the real local three-row database at `d1f3565` with identical
  source bytes and SHA-256 before and after, a verified backup, and imported
  notes readable through CLI, web API, and stdio/HTTP MCP.
- The final silent product tour MP4 at
  `scripts/tour/output/slipmem-product-tour.mp4` (SHA-256
  `a429e44b...cb96a0`, 107.96 s, no audio), recorded at `e408e47` from a real
  production build with a real HTTP MCP proposal approved in the browser.
- The historical focused suites recorded in section 0 at `56d009c`.

Not claimable yet:

- "383 passed". The clean-clone gate is 382 pass plus one conditional
  Playwright skip.
- A sanitized production/user-data SQLite database import. The evidence covers
  real startup-created sources, the frozen bootstrap fixture, and the actual
  local three-row test database (G5).
- Semantic entailment, factual correctness, or truth for synthesized prose.
  Only exact complete-paragraph extraction is proven (G6).
- That the focused test counts in section 0 are the full repository gate.
- Enforced offline/network isolation. `unshare -n` is denied in this
  environment; no external calls were observed, but isolation is not proven.
- A tour recording made at `d1f3565`. The recording is at `e408e47`; the later
  source commits are the approval-index refresh and test-budget change, and the
  media was deliberately not rerendered.

The release evidence is now closed for the named criteria and the nine
definition-of-done steps. The remaining limits are evidence scope, not open
gates: no production corpus, no semantic truth claim, no enforced network
namespace, and a video recorded two source commits before the gate.

## 11. Unverified acceptance cases: memory runtime, capture, graph, and initiatives (added 2026-11-22)

**Scope.** This section is separate from the release evidence in sections 0-10
and changes no earlier status. It records acceptance cases for the uncommitted
work in the current working tree: a model-required serving memory runtime,
queue-driven consolidation, main-push capture, a derived relation graph, and
initiative records. None of these cases has been run against a committed
snapshot, and no clean-clone gate covers them. Every case here is **Unverified**;
do not count it as an MVP **Pass** or cite it as evidence until a committed test
or a named independent run at a fixed commit exercises the whole clause.

**Relationship to the historical wording.** Sections 0-10 remain the record at
`d1f3565`/`2cdf077`. Their offline-operation statements describe that snapshot.
They do not establish that a future serve mode can run without a model, and this
section does not retroactively expand them. The old matrix has no acceptance case
for these paths, so its silence must not be read as coverage.

| ID | Acceptance case | Required observable result | Status |
| --- | --- | --- | --- |
| FUT-01 Required chat for serve | A serve process that enables the memory runtime has no model-less mode. | An explicit OpenAI-compatible chat provider, model, and base URL are required. Missing, partial, or invalid configuration stops startup with an actionable error; it must not silently disable memory, assume a default model, write a note, or call a provider. If Jev is not explicitly selected, structured per-note recall uses the same required model and validates each decision; a configured provider failure stays a per-note failure, not a keyword fallback. | Unverified |
| FUT-02 Offline local CLI remains useful | Ordinary non-serve CLI use must not inherit the serve requirement. | With no chat or recall provider configured and no network, local commands that do not explicitly opt into a model (`init`, `new`, `list`, `show`, `edit`, `delete`, `search`, `tags`, extractive `wiki`, `review`/`approve`/`reject`, `check`, `cache`, `migrate`, `legacy`) keep their current behavior and exit codes. No memory runtime, watcher, consolidation, recall egress, or provider construction starts. A serve process that does not enable the memory runtime likewise keeps its local MCP behavior and needs no model. `capture git` is the explicit exception: it requires its own model and fails closed before producing model-derived data when that model is absent. | Unverified |
| FUT-03 Queue-driven consolidation | Raw writes wake one bounded consolidation path without a normal timer. | A successful fleeting or literature write from CLI, MCP, HTTP, or capture causes one coalesced wake, and the durable note revision remains recoverable by a startup pass after restart. Unchanged revisions are not sent to the provider again. A cross-process wake failure is reported and leaves work for startup recovery rather than silently dropping it. Provider calls run outside the repository mutation lock, a run-level lease prevents overlapping consolidators, and provider failure is reported and never promoted to a successful write. | Unverified |
| FUT-04 Main-push capture | Capture is tied to an exact, verified Git range. | `slipmem capture git` accepts only exact lowercase full commit SHAs, requires after to descend from before (rejecting force-push, branch replacement, and reversed ranges), and never checks out, fetches, resets, or writes to the source checkout. When the adapter depends on the checked-out worktree, it also requires `HEAD` to equal the after commit and says so. Diff input is bounded. Model evidence must match a real commit, path, and hunk in the verified range. Note and checkpoint writes are idempotent. An ephemeral CI checkout must not be presented as updating an authoritative note root. Any authenticated ingress is opt-in, default unexposed, configured with a trusted local Git root, and accepts event SHAs rather than caller filesystem paths. | Unverified |
| FUT-05 Derived relation graph | The graph is derived and rebuildable, never a second source of truth. | Projection happens on demand from note artifacts. `derived_from` follows recorded source ID and hash. `supersedes` and `contradicts` appear only from a validated, evidence-pinned plan; `implements` is preserved read-only. Stale or missing targets remain visible. Projection never deletes, rewrites, promotes, or grants trust to a note. | Unverified |
| FUT-06 Initiative workspaces | Initiative planning stays outside default note and recall storage. | Records have stable IDs and durable scope, milestones, and assertions. Verification is advisory and evidence-pinned. Supported, contradicted, and not-evidenced assertions are reported separately. Only an individually landed and clearly supported assertion may be promoted, and arbitrary unchecked caller data cannot become verified. No Spec Kit dependency and no leakage into the default note or recall store. | Unverified |
| FUT-07 Write policy and provenance | Existing approvals and new automatic writes remain distinct. | MCP tool writes keep the approval policy. Maintenance and capture use distinct provenance. Maintenance writes directly and does not create pending proposals or obey `SLIPMEM_MCP_WRITE_POLICY`; enabling it is the operator's explicit write decision. No MCP tool can approve, reject, trigger, enable, or disable memory. A disabled or unconfigured runtime produces no egress, and credentials, prompts, response bodies, and endpoint URLs are not logged. | Unverified |
