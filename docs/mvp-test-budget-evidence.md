# Integration test budget evidence

Date: 2026-11-18
Snapshot: verified code head `e01daa3` (budget commits plus the concurrent
approval refresh); later commits for this note are documentation-only.
Status: **bounded per-test budgets raised for three load-sensitive integration
tests.** No test was skipped, retried, or weakened. No global timeout change was
made.

This note records why the three tests that timed out in independent release and
portable-acceptance runs now have explicit 30 s per-test budgets, and what was
deliberately left unchanged.

## 1. Observed failures

The independent release check (`/tmp/opencode/release-check/REPORT.md`, section
2) ran the exact gate three times on an 8-vCPU host while load average was 8.26.
Two complete runs failed only by per-test timeout, not by assertion:

| Run | Test | Observed | Result after timeout |
| --- | --- | --- | --- |
| 1 | `packages/mcp/src/tools.test.ts` "search is cross-kind, filterable, refreshed, and excerpt-bounded" | 5594.22 ms | test timed out after 5000 ms |
| 2 | `packages/cli/src/migrate.test.ts` "imports atomically with a verified backup and then skips duplicates in merge mode" | 5035.08 ms | test timed out after 5000 ms; a follow-up merge process was then killed with 143 |
| 3 | full gate | - | 374 pass, 1 skip, 0 fail |

The independent portable-acceptance run
(`/tmp/opencode/portable-acceptance/REPORT.md`, section on focused regression
tests) saw the same class of failure:

- `packages/core/src/markdown/search-index.test.ts` "cache loss and copied notes
  rebuild identical backlink identities" timed out at **6149.28 ms** while
  seven test files ran concurrently.
- The same file passed alone (20/20), and the combined suite passed twice with
  Bun's global `--timeout=20000` (41/41).
- The report explicitly treats this as a heavy-test budget under load, not a
  cache or search-index defect.

All three focused reruns passed immediately. The failures are scheduling and
process-startup/I/O contention under external load, not product assertions.

## 2. Changes

Each change is one third argument on the affected `test(...)` call. Subprocess
timeouts, cleanup, fixture content, and every assertion are unchanged.

| File | Test | Budget | Reason |
| --- | --- | --- | --- |
| `packages/cli/src/migrate.test.ts` | "imports atomically with a verified backup and then skips duplicates in merge mode" | `30000` ms | Six real CLI child processes: import, `check`, a second refused import, a refused human import, a merge, and a human merge. Each starts Bun on the CLI entry point and opens the SQLite source; the import also creates and verifies the backup. This is real process startup and migration I/O, not an in-process unit test. |
| `packages/mcp/src/tools.test.ts` | "search is cross-kind, filterable, refreshed, and excerpt-bounded" | `30_000` ms | Three note writes plus four MCP `search_notes` calls through the real Markdown service layer. Each search refreshes the SQLite FTS index, so the test pays layer startup and index build cost. Cross-kind filtering, topic filtering, injection excerpt bounds, and path assertions are retained. |
| `packages/core/src/markdown/search-index.test.ts` | "cache loss and copied notes rebuild identical backlink identities" | `30_000` ms | Three complete FTS index rebuilds: the original root, the root after deleting the cache directory, and a copied note-only root. The test proves the same note count and backlink identities after cache loss and after copying only the Markdown files; all assertions and both cleanup paths are retained. |

Later consolidation: the MCP search test named in this table was merged with the
tag, detail, and external-edit cases into `packages/mcp/src/tools.test.ts`
"MCP writes, edits, search ranking/filtering/refresh, and tag counts". That
consolidated test retains the explicit `30_000` ms budget; the
`migrate.test.ts` and `search-index.test.ts` budgets above are unchanged.

The 30 s value follows the existing convention in this repository: most CLI
tests that launch real child processes already pass `30000` (for example
`search.test.ts`, `notes.test.ts`, `wiki.test.ts`, `init.test.ts`,
`legacy.test.ts`, and the other `migrate.test.ts` cases). The real-server wrapper
test uses `45000`. The MCP bulk-recall test already uses `30_000`.

## 3. What was not changed

- No global `--timeout`, `bunfig.toml` default, preload, retry, or serialization
  switch was added. Those would hide slow tests across the whole suite instead
  of bounding the known process/build-heavy ones.
- No test was marked `skip`/`todo`, no assertion was removed, and no failure is
  suppressed.
- The existing subprocess interaction timeout in
  `packages/mcp/src/main.test.ts` (`readLine(..., 5000)`), process cleanup, and
  all `Bun.spawn`/`runCliProcess` behavior were left intact.
- The 50 maximum-size literature-note MCP recall test was **not** resized. Its
  fixture is the security/bounds proof (title, excerpt, reference, and recall
  caps over 50 hostile notes), and it already has a `30_000` ms budget. Reducing
  the corpus to buy speed would weaken that evidence.
- Pure in-process CPU tests with no process, import, build, or large-corpus
  stage keep Bun's default budget.

## 4. Verification

Verification used an isolated snapshot rather than the root working tree because
another workstream was concurrently editing approval and server/API files in the
same checkout. The snapshot was a clean clone of `b88f612` with only the three
test-file changes above applied.

Environment:

```text
Bun 1.4.4 (Linux x64), 8 vCPU
HOME=/tmp/opencode/test-budget/home
BUN_INSTALL_CACHE_DIR=/tmp/opencode/test-budget/bun-cache
CI=1
```

Install: `bun install --frozen-lockfile` -> 61 packages, 1.28 s.

Focused suites (the three changed files together):

```text
$ bun test packages/cli/src/migrate.test.ts \
    packages/mcp/src/tools.test.ts \
    packages/core/src/markdown/search-index.test.ts
44 pass, 0 fail, 818 expect() calls, 3 files, 22.89 s
```

Full gate on the same snapshot:

```text
$ bun run check
oxlint packages                                  clean
tsc --noEmit + packages/web tsconfig             clean
bun test                                         377 pass, 1 skip, 0 fail,
                                                 3222 expect() calls,
                                                 378 tests across 45 files,
                                                 130.47 s
vite client build                                497 modules, 915 ms
vite SSR build                                   451 modules, 816 ms
```

After the concurrent approval-refresh commit `8af9e27` landed, the same gate was
rerun in a second isolated clone at combined head `e01daa3` (the two budget
commits plus the approval refresh). Result: oxlint and both typechecks clean;
`382 pass, 1 skip, 0 fail, 3287 expect() calls, 383 tests across 45 files`,
114.24 s; Vite client 497 modules and SSR 451 modules. The three budgeted tests
remained green with their assertions unchanged. The checkout used for that
recheck is `/tmp/opencode/test-budget/final-snapshot`; its log is
`/tmp/opencode/test-budget/fullcheck-head.log`.

Host load during the focused and full runs was approximately 3-4, not the 8.26
of the independent failing run. No synthetic load was added during verification
to avoid disturbing the concurrent workstream. The observed timeout values above
are the load evidence; 30 s gives roughly 5-6x headroom over the 5.0-6.1 s
failures, while remaining a hard per-test bound.

Artifacts:

- `/tmp/opencode/test-budget/targeted.log`
- `/tmp/opencode/test-budget/fullcheck.log`
- `/tmp/opencode/test-budget/fullcheck-head.log`
- `/tmp/opencode/test-budget/repo` (patched snapshot)
- `/tmp/opencode/test-budget/final-snapshot` (combined-head checkout)
- `/tmp/opencode/release-check/logs/check.log`,
  `/tmp/opencode/release-check/logs/check-rerun.log`
- `/tmp/opencode/portable-acceptance/evidence/110-focused-tests.log`,
  `/tmp/opencode/portable-acceptance/evidence/112-focused-tests-timeout20s.log`

## 5. Interpretation

These three failures do not show a migration, search-index, or MCP defect. They
show that a 5 s per-test budget is too tight for a handful of tests that start
real processes or rebuild the FTS index on a loaded 8-vCPU host. The budgets are
now explicit and bounded at 30 s per test; a hang or assertion regression still
fails the test within that bound.

The final release checker should clone the committed head (not this evidence
snapshot) and rerun `bun run check` in its own isolated environment. A timeout
inside the new 30 s bounds is still a real failure; a pass at 5-10 s on a loaded
host is expected headroom, not a product regression.
