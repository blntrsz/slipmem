# MVP final independent check evidence

Date: 2026-11-18
Status: **final clean-checkout gate green at `d1f3565`.** This note records an
independent release check. It does not replace the criterion-by-criterion
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md).

Frozen source head:

| Item | Value |
| --- | --- |
| Commit | `d1f35656069d53a9d8e6cf73a437468065ffcdcd` (`d1f3565`) |
| Git tree | `551b740ee00335ae2878543e2bdf08e08c43905b` |
| `bun.lock` SHA-256 | `4295f55f0b9dd17c2c2dddac577fbaae128f9b29efc6fb35195482a5557c0f7c` |
| Bun | `1.4.4` |
| Relevant code commits | `8af9e27` approval index refresh, `24a5c39` time budgets |
| Final commits after `8af9e27` | docs and test-timeout changes only |

The source repository was clean when this check was captured. No app/code
worker was active. The full gate ran in a fresh clone of `d1f3565`, not in the
shared working tree and not against the shared `packages/web/dist`.

## 1. Clean checkout, frozen install, full gate

Commands, with no test-timeout override and no `bunfig.toml` (Bun default 5 s):

```sh
git clone --no-local /home/dev/src/slipmem /tmp/opencode/release-final-d1f3565
cd /tmp/opencode/release-final-d1f3565
bun install --frozen-lockfile
bun run check
```

Results:

```text
bun install --frozen-lockfile: exit 0, 61 packages installed
bun run lint:                 clean (oxlint packages)
bun run typecheck:            clean (root and packages/web)
bun test:                     382 pass, 1 skip, 0 fail
                              3287 expect() calls
                              383 tests across 45 files in 138.58 s
bun run web:build:            Vite client and SSR build successful
bun run check:                exit 0, 148.83 s wall time
```

This is **not** "383 passed". One test is conditionally skipped, as described
below. The run used the default 5 s per-test timeout; no timeout was raised for
this evidence.

Install left one mode-only difference in the otherwise clean clone:
`packages/mcp/src/main.ts` changed from `100644` to `100755`. Content was
unchanged (`sha256 65d00a72622fc6bb84e6e0aa540bb9bb1684c974cef12f4026465cac636f5017`
before and after), and `git diff` shows only the mode change. Bun links the
workspace package `bin` entry during install. This is a checkout-hygiene caveat,
not a source change.

The skipped test is
`scripts/tour/record.test.mjs` "records a fixture, redacts inputs, contains
artifacts, and blocks external navigation". The file selects `test.skip` when
`playwright` or its Chromium binary is unavailable; the clean clone has neither.
The product tour itself was recorded separately by the tour worker at `d1f3565`
and is not part of this gate.

No test failed or flaked in this run. An earlier worker saw load-sensitive
subprocess timeouts before `24a5c39` bounded three integration tests. They did
not reproduce here at the default timeout, and no timeout-only pass is claimed.

## 2. New-user local loop at the frozen head

All commands ran in a fresh project directory against the `d1f3565` CLI, with
isolated `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_DATA_HOME`.

```text
init:                         created .slipmem/, .state/, README.md, .gitignore
new fleeting:                 20261118012316-bounded-recall-is-a-product-rule
new permanent:                20261118012317-files-are-the-source-of-truth
new literature:               20261118012318-local-first-note-systems-keep-portable-files
list:                         3 notes; 1 per type filter; 2 for topic agent-memory
show:                         all three IDs printed metadata, body, and path
search bounded:               1 hit; search portable --type literature: 1 hit
topics:                       agent-memory 2, local-first 1, recall 1
wiki agent-memory:            1 note, extractive, cited permanent note
wiki local-first:             1 note, extractive, cited literature note
wiki absent-topic:            0 notes, no invented content, topic suggestions
wiki --out outside root:      wrote 458 bytes outside .slipmem/
literature without reference: exit 1, field reference, no note file created
check:                        3 notes, 0 errors, 2 expected unexpected-file warnings
                              (.gitignore and README.md), 0 index drift
```

Layout after the loop: three flat `*.md` notes plus `README.md`, `.gitignore`,
and `.state/`. No `fleeting/`, `permanent/`, or `literature/` directory. All
three note filenames match `^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$` and their
`id` equals the filename stem; the only pattern-check exception printed was the
required `README.md`, which is not a note.

Cache recovery:

```text
cache clear:                  3 indexed notes -> 0; notes untouched
check immediately after:      report.index.drift = 3 (expected index-missing)
check --rebuild-index:        3 notes, drift 0, rebuilt = true
list IDs before/after:        identical
search IDs before/after:      identical
cache path:                   isolated XDG cache, outside the note root
```

## 3. Read-only legacy view and migration from an actual database

Source: the real local default database at
`/home/dev/.local/share/slipmem/slipmem.db`, copied before use.

| Source fact | Value |
| --- | --- |
| Size | 32,768 bytes |
| SHA-256 | `31278cdeb828df075c660ed3a90816655f4f9ca5525f33bed31cb06f6c8435d9` |
| Tables | `fleeting_note`, `permanent_note`, `literature_note`, `__drizzle_migrations` |
| Rows | 1 fleeting, 1 permanent, 1 literature; one applied Drizzle migration |
| WAL | empty, SHA-256 `e3b0c442...b855` |
| SHM | SHA-256 `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

This is a real startup-created database containing three MCP-created test notes,
not a sanitized production or real-user corpus. It is representative of the
current schema and all three note types; no broader data claim is made.

### 3.1 Default-env read-only view

With the byte-identical copy at `$XDG_DATA_HOME/slipmem/slipmem.db` and no
`--db`:

```text
legacy list:                  total 3, all valid, one row per type
legacy list --type fleeting:  total 1
legacy show --type literature --id 38cae67c-…:  reference "MCP integration test"
legacy show --type permanent --id 000dcdcb-…:   body and timestamps preserved
warning:                      read-only-one-release on every response
```

The source hash and bytes were unchanged after every command. The real default
database's `db`, `wal`, and `shm` hashes also matched the captured values after
the whole verification.

### 3.2 Migration

The migration source copy contained only `slipmem.db` (the real WAL was empty),
so a new `-shm` beside it would be visible.

```text
migrate sqlite --dry-run:     3 planned, 0 collisions, 0 issues, 0 errors
                              target stayed absent; source hash unchanged
migrate sqlite:               status imported
                              3 rows -> 3 planned -> 3 written
                              0 skipped, 0 malformed, 0 quarantined
                              source unchanged: yes
                              backup verified: yes
                              verification: OK (3 expected, 3 written, 3 parsed)
source after import:          one file, same SHA-256, no -shm created
```

Imported notes:

| Type | ID | File SHA-256 |
| --- | --- | --- |
| fleeting | `20261114183857-mcp-test-fleeting-note` | `9901514cb4699465aef50ed9be4636ad4b23b7b38924465cb37ae21cfc6b49b0` |
| permanent | `20261114183857-mcp-test-permanent-note` | `9cc4b8e9cb9336dd44835fc95cea6f11fa543af5200322100df487085d0e04ed` |
| literature | `20261114183857-mcp-test-literature-note` | `f1a52c95920cc06ee0db1fc8f02107946392d0b9c3f3c3f44b5d1f57024530ef` |

The literature reference survived, timestamps were converted to whole UTC
seconds as specified, and the original millisecond values remain visible only
through the read-only legacy view. `check` reported 3 notes, 0 errors, 1
expected `.gitignore` warning, and the CLI list/search/wiki reads all succeeded.
Sub-second milliseconds are intentionally not preserved in Markdown filenames
or ISO timestamps.

## 4. Imported notes through web and MCP

Web production server from the clean clone's built `dist`, isolated cache, port
`47831`, same migrated root:

```text
GET /api/health:              200, noteCount 3, index mode fts5
GET /api/notes:               200, 3 notes, ids and all three types
GET /api/notes/<literature>:  200, id/title/content/reference correct
GET /api/search?q=MCP:        200, 3 results
GET /api/topics:              200, [] (migrated rows have no topics)
GET /api/wiki/mcp:            200, 2 cited sources (fleeting excluded)
GET /:                        200
GET /notes/<literature>:      200
POST /mcp initialize:         200, session established, protocol 2025-11-25
HTTP MCP tools/list:          18 tools
HTTP MCP get_literature_note: correct title and reference
```

The HTML routes are client-hydrated shells in this build; a hydrated browser
run was not repeated here because Playwright/Chromium is not installed in the
clean clone. The browser acceptance run recorded independently at `b6f3cfe`
remains the hydrated-UI evidence; this check directly proves the web API and
HTTP MCP read the migrated files.

Stdio MCP from the same root:

```text
18 tools; no approve, reject, or apply tool
list_fleeting_notes:          1
get_fleeting/permanent/literature: all three returned correct content
search_notes "MCP":           3 notes
build_topic_wiki "mcp":       2 cited sources
process exit:                 0, stderr empty
```

## 5. Approval index refresh (`8af9e27`) independently reproduced

This targets the plan gap where approval wrote a note but left the disposable
index stale until the next search. Proposals were created through real stdio
MCP and applied through the real CLI; HTTP proposals were created through the
real HTTP MCP endpoint and applied through `POST /api/pending/<id>/approve`.

```text
CLI create approval:          index.status refreshed; immediate check drift 0;
                              zero index-* warnings; note listable
CLI update approval:          index.status refreshed; immediate check drift 0;
                              updated body readable
CLI delete approval:          index.status refreshed; immediate check drift 0;
                              zero index-* warnings; note file removed, backup kept
HTTP create approval:         index.status refreshed; immediate CLI check drift 0
HTTP delete approval:         index.status refreshed; immediate CLI check drift 0
pre-approval permanent file:  absent for every create
```

No `search`, `topics`, health request, or `check --rebuild-index` ran between
approval and the drift check.

## 6. Synthesized wiki and sandbox privileges

`bwrap` is installed but cannot create its sandbox in this environment:

```text
$ bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent /bin/true
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
exit 1
$ unshare -n true
unshare: unshare failed: Operation not permitted
```

With a configured local agent and no sandbox opt-in, synthesized mode fails
closed with `synthesis-config` and the exact recovery message naming
`SLIPMEM_WIKI_AGENT_UNSAFE=1`. It does not run the agent unsandboxed by default.

With that explicit unsafe opt-in, a test agent returned the **complete
two-sentence source paragraph** from the permanent note: the page was accepted,
`noteCount 1`, cited to
`20261118012317-files-are-the-source-of-truth`. Returning only the first
sentence of the same paragraph produced `noteCount 0`, zero sections, and "No
synthesized sentences passed citation validation (1 omitted)".

This confirms the documented whole-paragraph rule and the fail-closed sandbox
behavior. It does not claim semantic entailment, factual truth, or that an
unsafe-opted-in agent is confined. Running synthesized mode with a working
sandbox was not possible in this environment.

## 7. Open caveats and claims not made

- The gate is **382 passed + 1 conditional skip**, not 383 passed. The skip is
  the Playwright-gated tour recorder; Playwright/Chromium is not a dependency of
  the clean clone.
- `bun install --frozen-lockfile` does not leave a porcelain-clean clone: it
  sets the executable bit on `packages/mcp/src/main.ts` because Bun links the
  workspace `bin` entry. File contents and the lockfile are unchanged.
- "Offline" could not be enforced with a network namespace: `unshare -n` is
  denied. Install used the local Bun cache (61 packages in under 1 s), and the
  CLI/MCP/web loop made no observed external calls, but this run does not prove
  network isolation.
- The migrated database is an actual local default database with three test
  notes, one per type. It is not a sanitized production dump or a real-user-data
  corpus. All three rows imported with no reported data loss.
- The hydrated browser UI was not rerun in this clean clone. The web API,
  HTTP MCP, SSR route status, and the earlier independent browser run are the
  available evidence.
- Synthesis is proven only as exact complete-paragraph citation. No semantic
  entailment, paraphrase acceptance, or truth claim is made. The sandbox itself
  was not usable here; only its fail-closed path was exercised.
- Later commits after the gate were docs-only or test-budget changes. Source at
  `d1f3565` includes `8af9e27` and `24a5c39`; any later docs-only commit does
  not change the verified `packages/` source tree.

## 8. Artifact locations

Supplemental logs from this run (ephemeral, outside the repository):

```text
/tmp/opencode/release-final-d1f3565-check.log
/tmp/opencode/release-final-d1f3565-work/logs/user-loop.log
/tmp/opencode/release-final-d1f3565-work/logs/migration.log
/tmp/opencode/release-final-d1f3565-work/logs/mcp-summary.json
/tmp/opencode/release-final-d1f3565-work/logs/web-check-console.log
/tmp/opencode/release-final-d1f3565-work/logs/synth.log
/tmp/opencode/release-final-approval/logs-run.log
```

The durable record is this committed note: commit, tree, lockfile hash, counts,
source-database hash, imported-file hashes, and the caveats above.
