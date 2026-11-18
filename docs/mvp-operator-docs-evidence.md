# Operator guide documentation evidence

Date: 2026-11-18

Scope: evidence for `docs/operator-guide.md`. This task changed documentation
only. No package source, CLI command, migration, MCP, server, or web code was
edited.

Verification tree: repository HEAD `955ee07` plus concurrent worker changes in
the working tree at the time of the final smoke run. Other workers were actively
landing CLI, MCP, approval, and web cutover commits during this task; results
below are the observed behavior at the end of the task, not a claim that the
tree is frozen.

## 1. Files added

- `docs/operator-guide.md` - operator guide for plaintext `.slipmem/` notes,
  local state/cache, recovery, Git backup, migration, MCP access and approvals,
  local HTTP security, and conflict recovery.
- `docs/mvp-operator-docs-evidence.md` - this evidence note.

Earlier docs were not edited. `docs/mvp-plan.md`,
`docs/mvp-implementation-log.md`, migration/mcp/web evidence owned by other
workers, the root README, and package READMEs were left untouched. No earlier
document was marked superseded here: the remaining SQLite-first prose lives in
those owned files, and this guide records the stale-README gap instead of editing
them.

## 2. Command surface verified by `--help`

Run from the repository root:

```sh
bun run slipmem -- --help
bun run slipmem -- help migrate
bun run slipmem -- help wiki
bun run slipmem -- help delete
bun run slipmem -- help review
bun run slipmem -- help approve
bun run slipmem -- help reject
```

The final help output listed:

```text
init, new, list, show, edit, delete, search, topics, check, wiki, migrate,
review, approve, reject, mcp, web
```

Documented command forms matched the help text, including:

- `migrate sqlite --db <path> [--dry-run] [--merge] [--json]`
- `wiki <topic> [--limit <n>] [--mode extractive] [--include-fleeting] [--out <path>] [--json]`
- `delete <id> [--yes] [--json]`
- `review [--json]`
- `approve <proposal-id> [--json]`
- `reject <proposal-id> [--json]`

Known entrypoint gap resolved after the first draft: `slipmem mcp` and
`slipmem web` previously resolved `repositoryRoot` to `packages/`, producing
`packages/packages/...`. The wrappers now resolve the checkout root four levels
up, start from the caller's cwd, and pass the resolved note root to the child.
The CLI workstream added real launch tests; see
[`docs/mvp-cli-evidence.md`](./mvp-cli-evidence.md).

## 3. CLI note workflow smoke test

Disposable root: `/tmp/opencode/slipmem-operator-final`.

```sh
bun run slipmem -- init --dir "$ROOT"
bun run slipmem -- new --dir "$ROOT" --type fleeting --title 'Bounded recall' \
  --content 'Search must have a hard limit.' --topic agent-memory
bun run slipmem -- new --dir "$ROOT" --type literature --title 'Cited source' \
  --content 'Cite the note file.' --reference 'Book, chapter 2' --topic agent-memory
bun run slipmem -- new --dir "$ROOT" --type permanent --title 'Local first' \
  --content 'Files are the source of truth.' --topic local-first
bun run slipmem -- list --dir "$ROOT"
bun run slipmem -- list --dir "$ROOT" --type permanent --limit 5
```

Observed:

- Init created `.slipmem/`, `.state/`, `README.md`, and `.gitignore`.
- Three notes were created with `YYYYMMDDHHmmss-<slug>.md` filenames.
- `list` showed all three types and honored the type/limit filter.
- `show` printed metadata, body, and path.
- `edit` through a scripted `SLIPMEM_EDITOR` updated the note atomically.
- An invalid permanent draft over the 2000-character limit exited 1, reported
  `field: content`, and left the original file byte-identical (`cmp` clean).
- A literature create without `--reference` exited 1 with the required-reference
  error and created no file.
- `delete <id>` without `--yes` in a non-interactive shell exited 2 and removed
  nothing. `delete <id> --yes` removed the note from the root and printed the
  trash path under `$XDG_STATE_HOME/slipmem/trash/<root-key>/`.

## 4. Recall, wiki, and cache recovery

Disposable root as above.

```sh
bun run slipmem -- search "hard limit" --dir "$ROOT"
bun run slipmem -- topics --dir "$ROOT"
bun run slipmem -- check --dir "$ROOT"
bun run slipmem -- check --rebuild-index --dir "$ROOT"
bun run slipmem -- wiki agent-memory --dir "$ROOT"
bun run slipmem -- wiki agent-memory --include-fleeting --dir "$ROOT"
bun run slipmem -- wiki agent-memory --out /tmp/wiki.md --dir "$ROOT"
bun run slipmem -- wiki agent-memory --out "$ROOT/wiki.md" --dir "$ROOT"
bun run slipmem -- wiki agent-memory --mode synthesized --dir "$ROOT"
```

Observed:

- `search` returned the fleeting note with an excerpt and `index: fts5`.
- `topics` reported `agent-memory 2` and `local-first 1`.
- `check` reported 3 notes, 0 errors, 2 `unexpected-file` warnings for
  `README.md` and `.gitignore`.
- `check --rebuild-index` rebuilt the index and reported 0 drift.
- Default `wiki agent-memory` selected only the literature note; adding
  `--include-fleeting` selected the fleeting note too. Both pages cited note IDs
  and file paths and wrote nothing under the note root.
- `--out /tmp/wiki.md` wrote outside the root.
- `--out "$ROOT/wiki.md"` exited 2: `--out must point outside the note root`.
- A synthesized request without a configured synthesizer exits 1 with
  `synthesis-config`; it does not downgrade or write a page.
- A local fixture agent configured through `--agent`/`--agent-arg` produced a
  cited synthesized page over argv with bounded JSON on stdin. The fixture used
  the documented `SLIPMEM_WIKI_AGENT_UNSAFE=1` opt-in because the test host's
  bubblewrap probe failed.
- `--model local-model` exited 1 with `synthesis-adapter-unsupported`; the CLI
  ships no model adapter and never guesses a provider.
- A missing `--out` parent and a symlinked parent into the note root both
  exited 2 before writing.
- Cache path was `~/.cache/slipmem/index/<root-key>/index.sqlite`, directory
  mode `0700`, file mode `0600`.
- Deleting the cache directory and rerunning `search` recreated the index and
  returned the same result. There is no `cache clear` command; the guide
  documents `check --rebuild-index` and manual removal with no process running.

## 5. Git conflict recovery

Injected unresolved markers into a valid permanent note:

```text
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
```

Observed:

- `check` exited 1 with `conflict-markers` and `index-extra` drift.
- `show` and `edit` exited 1 with `conflict-markers`; `edit` never opened a
  writable draft.
- `list` exited 0 but omitted the invalid note. The guide therefore says to use
  `check`, not `list`, to confirm a conflicted note still exists.
- Restoring the original file and running `check --rebuild-index` returned OK.
- No command auto-resolved or deleted anything.

## 6. SQLite migration CLI

Built disposable SQLite databases from the Phase 0 fixtures:
`packages/core/fixtures/phase0/migration/current.sql` and
`invalid-rows.sql`. Source SHA-256 values were recorded before and after.

```sh
bun run slipmem -- migrate sqlite --db "$BASE/current.db" --dry-run --dir "$BASE/notes"
bun run slipmem -- migrate sqlite --db "$BASE/current.db" --dir "$BASE/notes"
bun run slipmem -- migrate sqlite --db "$BASE/current.db" --merge --dir "$BASE/notes"
bun run slipmem -- migrate sqlite --db "$BASE/invalid.db" --dry-run --dir "$BASE/invalid-notes"
bun run slipmem -- migrate sqlite --db "$BASE/invalid.db" --dir "$BASE/invalid-notes"
```

Observed:

- Dry run: 3 rows, 3 planned, 0 malformed, `source unchanged: yes`, no target
  directory created, source SHA unchanged.
- Import: 3 written, 3 parsed, `verification: OK`, source SHA unchanged,
  `source-backup.db` and `manifest.json` under
  `.state/migrations/<run-id>/`, backup `verified: yes`.
- Re-run with `--merge`: 0 written, 3 `skipped-legacy-id`, no duplicate notes;
  collisions reported because existing filenames were taken.
- Real import into a non-empty root without `--merge`: exited 1 with
  `root-not-empty`, wrote no notes, reported the failure in the human report.
- Invalid fixture dry run: 5 malformed rows, 6 source errors, exited 1, wrote
  nothing.
- Invalid fixture real import: 5 quarantined rows, 6 source errors, exited 1;
  `manifest.json`, `source-backup.db`, `quarantine/*.json`, and
  `quarantine/index.json` remained; source SHA unchanged.
- Quarantine files contained the full raw source row and the issue code(s); text
  was not truncated. A note table missing required columns is no longer skipped
  at table level: every row becomes an error issue with its complete raw row and
  is quarantined. The remaining table-level case, an unsupported object such as
  a view at a note table name, has no rows to read and is reported in the
  plan/manifest without a row quarantine file.
- A pre-write failure (for example a refused non-empty root) prints
  `verification: not run`; it does not present the empty report's `ok: true` as a
  successful target verification.
- A merge re-run reports effective collisions in `counts.collisions` (zero when
  all rows were already imported), and each skipped note points at the actual
  existing target path; the human sample mapping prints that path.
- A manifest left `running` by a dead process is marked `interrupted` and appears
  in `interruptedRuns` and the human "Interrupted runs" section. A live owner is
  reported as `interrupted-run-active` and is never overwritten.
- JSON output tags unsafe integers and BLOBs as `$bigint` and `$base64` instead
  of rounding them or failing serialization.
- `source-changed` before the backup or writes stops the import with no notes.
  The final post-write check can also fail with `source-changed`; in that case
  imported notes, backup, manifest, and quarantine remain and must be inspected
  before any retry. The guide documents both phases.

## 7. MCP writes and approval policy

Used a disposable `McpTest` client over the real `McpNoteRegistrations` layer and
a disposable note root.

Default policy observed:

```text
create_fleeting_note  -> direct note
create_literature_note -> direct note
create_permanent_note -> pending_approval + proposal id
delete_fleeting_note  -> pending_approval + proposal id (note retained)
```

`SLIPMEM_MCP_WRITE_POLICY=direct` observed:

- `create_permanent_note` wrote directly.
- The note frontmatter recorded `provenance.source: mcp-direct`.
- `delete_fleeting_note` still returned `pending_approval`; the unsafe policy
  never bypasses deletes.

Human approval CLI:

```sh
bun run slipmem -- review --dir "$ROOT"
bun run slipmem -- approve "$PERMANENT_PROPOSAL" --dir "$ROOT"
bun run slipmem -- reject "$DELETE_PROPOSAL" --dir "$ROOT"
```

Observed:

- `review` listed both proposals with summaries, diffs, actor, expiry, and
  operation.
- `approve` applied the permanent create and wrote the note.
- `reject` removed the delete proposal and left the fleeting note in place.
- A subsequent `review` reported 0 pending proposals.
- Stale-base test: created an update proposal, edited the note through the CLI,
  then reviewed and approved. `review` marked the proposal `[STALE]`; `approve`
  exited 1 with the stale-base message, wrote nothing, left the human-edited
  note and the proposal file intact.

## 8. Local HTTP and approval API

Production web build and server:

```sh
bun run web:build
SLIPMEM_DIR="$ROOT" PORT=31343 bun run web:serve
```

Observed:

- `GET /api/health` returned `ok: true`, the Markdown note root, and the index
  path/mode.
- `GET /api/pending` returned the pending list shape.
- `GET` pages returned 200 for `/`, `/review`,
  `/notes/<id>`, `/notes/<id>/edit`, `/notes/<id>/delete`, `/new`, `/search`,
  `/topics`, `/wiki/<topic>`, and `/health`.
- `POST /mcp` with a JSON-RPC `initialize` returned 200, protocol
  `2025-11-25`, and serverInfo `slipmem 0.0.0`. The web server now mounts `/mcp`
  with the shared MCP registrations.
- API approval smoke: a permanent create and a delete were queued through MCP;
  `GET /api/pending` returned 2; approving the permanent proposal applied it;
  rejecting the delete proposal left the fleeting note; `GET /api/health`
  returned 200.
- API CRUD smoke: `POST /api/notes`, `GET /api/notes/<id>`,
  `GET /api/search?q=...`, `GET /api/topics`, `GET /api/wiki/<topic>`, and
  `DELETE /api/notes/<id>` all returned 200. Delete moved the file to the trash
  path and returned the backup path.
- `wiki` API default excluded fleeting notes; the topics endpoint still counted
  them. This matches the CLI behavior and is intentional.

## 9. Security checks from code

Verified in the current implementation, not only from prose:

- `packages/server/src/config.ts`: default host `127.0.0.1`, default port 3000,
  loopback host set, non-loopback warning helper.
- `packages/web/scripts/serve.ts`: default `HOST` is `127.0.0.1`.
- `packages/server/src/api.ts`: mutations require JSON content type and enforce
  same-origin `Origin`/`Sec-Fetch-Site`; `Origin: null` is rejected; no CORS
  headers are emitted; bodies are bounded.
- `packages/core/src/markdown/root.ts`: cache and trash live outside the note
  root, keyed by SHA-256 of the resolved root.
- `packages/core/src/markdown/search-index.ts`: cache directory `0700`, index
  file `0600`, refuses an index path inside the note root.
- `packages/core/src/approval/policy.ts`: permanent create/update/reclassify and
  all deletes pending by default; unsafe direct never bypasses deletes; unknown
  policy values fail closed.
- MCP registrations expose no approve/reject tool. Approval apply/reject is
  only available through the CLI/web/API human surfaces.

## 10. Gaps and unverified claims

The guide intentionally marks these gaps:

- `slipmem cache clear` does not exist; use `check --rebuild-index` or manually
  remove the cache with no process running.
- The CLI ships no model adapter registry. A `--model` request is forwarded to
  the core and fails closed with `synthesis-adapter-unsupported` unless the
  embedding application registered that exact ID. The agent path is verified.
- Agent synthesis depends on a working bubblewrap probe. When the probe fails,
  the core refuses the agent unless the documented unsafe
  `SLIPMEM_WIKI_AGENT_UNSAFE=1` opt-in is set; the guide states the privilege
  consequence rather than claiming sandbox isolation.
- The root README and package READMEs were being updated by other workers during
  this task and were not edited here.
- The working tree was not frozen. The final smoke run was against the CLI
  commits plus concurrent core changes; re-run the commands above after the
  cutover settles.

## 11. Verification commands used

```sh
bun run slipmem -- --help
bun run slipmem -- init --dir <disposable>
bun run slipmem -- new --dir <disposable> --type ... --title ... --content ...
bun run slipmem -- list --dir <disposable>
bun run slipmem -- show <id> --dir <disposable>
bun run slipmem -- edit <id> --dir <disposable>          # with SLIPMEM_EDITOR
bun run slipmem -- delete <id> --yes --dir <disposable>
bun run slipmem -- search <query> --dir <disposable>
bun run slipmem -- topics --dir <disposable>
bun run slipmem -- check --dir <disposable>
bun run slipmem -- check --rebuild-index --dir <disposable>
bun run slipmem -- wiki <topic> --dir <disposable>
bun run slipmem -- wiki <topic> --mode synthesized --agent "<bun> <fixture-agent>" \
  --agent-arg=--fixture-flag --dir <disposable>
SLIPMEM_DIR=<root> bun run slipmem -- mcp        # MCP initialize over stdio
SLIPMEM_DIR=<root> PORT=<port> bun run slipmem -- web
bun run slipmem -- migrate sqlite --db <db> --dry-run --dir <disposable>
bun run slipmem -- migrate sqlite --db <db> --dir <disposable>
bun run slipmem -- migrate sqlite --db <db> --merge --dir <disposable>
bun run slipmem -- review --dir <disposable>
bun run slipmem -- approve <proposal-id> --dir <disposable>
bun run slipmem -- reject <proposal-id> --dir <disposable>
bun run web:build
SLIPMEM_DIR=<root> PORT=<port> bun run web:serve
```

MCP and API smoke clients were disposable Bun scripts under `/tmp/opencode/`;
no repository source or fixture was modified by the tests.

## 12. Follow-up verification after the CLI fixes

The operator guide was updated again when the CLI workstream closed the
documented gaps:

```text
$ bun test packages/cli
 45 pass
 0 fail
 383 expect() calls
Ran 45 tests across 12 files.
```

The added launch coverage runs from a disposable directory outside the
repository:

- `slipmem mcp` starts the real stdio server and completes an MCP `initialize`
  handshake with `--dir` pointing at the disposable root.
- `slipmem web` launches the real Vite entry point with forwarded argv from the
  same disposable cwd and exits successfully without a `packages/packages`
  path error. The operator guide's separate HTTP section covers the serving
  surface.
- Synthesized wiki fixtures cover argv-only agent execution, environment
  selection, the extractive override, missing synthesizer, unregistered model,
  mutually exclusive flags, and the sandbox/unsafe opt-in boundary.
- Migration coverage asserts the human report prints `verification: not run`
  for a pre-write failure, uses effective collisions on a merge re-run, prints
  actual skipped target paths and interrupted runs, and tags unsafe integers and
  blobs in JSON.

The source-of-truth evidence for these CLI changes remains
[`docs/mvp-cli-evidence.md`](./mvp-cli-evidence.md). This note records the
operator-facing commands and the guide's accuracy checks.
