# @slipmem/cli

The `slipmem` command is the reference human interface to a flat Markdown note
repository under `.slipmem/`. It uses the shared `@slipmem/core` Markdown
repository, disposable search index, migration importer, wiki service, approval
service, Git-capture adapter, read-only graph, and initiative records. It does
not maintain a second note store or a type directory.

## Quickstart

From the repository root:

```sh
bun install
bun run slipmem -- init
bun run slipmem -- new --type fleeting --title "First thought" --content "Capture the idea."
bun run slipmem -- list
bun run slipmem -- search idea
```

After `init`, every invocation finds the nearest ancestor `.slipmem/`. Set
`SLIPMEM_DIR` or pass `--dir <path>` to use another root for one command.

```sh
bun run slipmem -- init --dir /tmp/slipmem-demo
SLIPMEM_DIR=/tmp/slipmem-demo bun run slipmem -- new --type permanent \
  --title "Bounded recall" --content "Every list and search has a hard limit."
```

## Commands

| Command | Behavior |
| --- | --- |
| `init` | Create `.slipmem/`, `.state/`, a starter README, and `.gitignore`. Idempotent. |
| `new --type <type> --title <title>` | Create a note from `--content`, non-interactive stdin, or an editor draft. |
| `list [--type <type>] [--tag <tag>] [--limit <n>]` | Bounded list with IDs, types, titles, and updated times. |
| `show <id>` | Print metadata, body, and the file path. |
| `edit <id>` | Open a full-note temporary draft, validate on save, then write atomically. |
| `delete <id>` | Move one note to the local trash backup. Requires `--yes` when non-interactive. |
| `search <query> [--type <type>] [--tag <tag>] [--limit <n>]` | Refresh the disposable index, then run bounded ranked search. |
| `tags [--query <tag>] [--limit <n>]` | List derived tag slugs and note counts. |
| `check [--rebuild-index]` | Validate filenames, metadata, limits, duplicate IDs, conflict markers, internal link targets, non-note files, and index drift. |
| `cache clear` | Clear only the derived search index through the core index API; notes and local state are untouched. |
| `capture git --before <sha> --after <sha> [--repo <path>] [--consolidate]` | Verify one main-push range, extract bounded evidence-pinned fleeting sources, and write an idempotent checkpoint. Inherits `SLIPMEM_CHAT_*`, with optional `SLIPMEM_CAPTURE_*` overrides. See [`docs/git-capture.md`](../../docs/git-capture.md). |
| `graph [<note-id>] [--from <id>] [--to <id>] [--kind <kind>] [--status current\|stale\|missing] [--no-links] [--limit <n>]` | Project typed maintenance relations plus disposable Markdown links; read-only and version-aware. |
| `initiative <create\|list\|show\|scope\|verify\|promote\|project\|reconcile\|pin\|milestone\|assertion> ...` | Manage durable initiative records under `.slipmem/initiatives/`, advisory code/test evidence, and one-assertion-at-a-time promotion/projection into permanent notes. |
| `wiki <tag> [--mode extractive\|synthesized] [--model <id> \| --agent <command>] [--agent-arg <arg>...] [--include-fleeting] [--out <path>]` | Build an on-demand cited tag page through the shared wiki service. |
| `review` | List pending agent proposals with summaries, diffs, and stale/expired flags. |
| `approve <proposal-id>` | Apply a proposal after revalidating its base hash, expiry, and note rules. |
| `reject <proposal-id>` | Remove a proposal without changing any note. |
| `migrate sqlite [--db <path>] [--dry-run] [--merge]` | Plan or import legacy SQLite notes with a verified backup and manifest. |
| `legacy list` / `legacy show` | Read the retired SQLite database through the one-release, read-only compatibility view. |
| `mcp` / `web` | Thin wrappers around the existing MCP stdio and Vite development entry points. They resolve the note root first and pass it to the child as `SLIPMEM_DIR`. |

`mcp` and `web` start serving processes, so they require an explicit
OpenAI-compatible primary chat model (`SLIPMEM_CHAT_PROVIDER`,
`SLIPMEM_CHAT_MODEL`, `SLIPMEM_CHAT_BASE_URL`, optional
`SLIPMEM_CHAT_API_KEY`). Ordinary note commands stay local and need no model.
The legacy `SLIPMEM_MAINTENANCE_*` names are accepted aliases, and
`SLIPMEM_AUTO_MEMORY` no longer disables a serving runtime.

Add `--json` to any command for a machine-readable result. Validation errors
also use JSON when `--json` is present and are written to stderr with a nonzero
exit status.

Exit statuses are `0` success, `1` note/validation/migration failure, and `2`
usage or an explicitly unavailable feature.

## Content and editor drafts

`new` resolves content in this order:

1. `--content <text>`.
2. Non-interactive stdin, for example `printf 'body' | slipmem new ...`.
3. `$SLIPMEM_EDITOR`, `$VISUAL`, or `$EDITOR` on a temporary body draft.

`edit` always writes the current note to a temporary directory outside the note
root, opens that full note in the editor, and parses it with the real contract on
save. Invalid YAML, a mismatched ID, an invalid type or reference, conflict
markers, or an oversized body fail with the note path and field; the original
file is untouched. `createdAt`, `updatedAt`, `id`, unknown frontmatter keys,
`legacyId`, and `aliases` are managed metadata and cannot be changed through the
editor draft.

Literature notes require `--reference`. Content limits are 1000 characters for
fleeting notes, 2000 for permanent notes, and 5000 for literature notes.

## Search, tags, check, and index

The search index lives outside the note root under
`$XDG_CACHE_HOME/slipmem/index/<root-hash>/` and is disposable. `search` and
`tags` refresh it before reading, so an editor change is visible without a
manual import. `check --rebuild-index` is the full recovery path when the index
is missing or stale.

`cache clear` deletes only the derived rows through the shared core index API.
It never removes note files, `.state/`, or the cache directory. It is safe
before an index exists, and the next `search`, `tags`, or
`check --rebuild-index` repopulates it. Manual cache-directory removal remains
an emergency fallback when no slipmem process is running.

`check` never renames, repairs, or resolves anything. Errors make it exit `1`;
warnings such as non-note files or slug drift do not.

## Wiki boundary

`slipmem wiki` uses the shared core wiki service: permanent and literature notes
are selected by normalized tag, each excerpt is quoted verbatim, and every
section carries a note ID and file citation. Fleeting notes are excluded unless
`--include-fleeting` is passed. `--out` must name an existing parent directory
outside `.slipmem/`; the default is stdout. A symlinked parent or output symlink
that resolves into the note root is rejected before anything is written.

Extractive mode is the default. Synthesized mode is opt-in:

```sh
# A local agent: argv, not a shell. Notes arrive as bounded JSON on stdin.
bun run slipmem -- wiki agent-memory --mode synthesized \
  --agent "/opt/local-synthesizer --flag" --agent-arg "--model=small"

# Equivalent environment form used by other surfaces:
SLIPMEM_WIKI_SYNTHESIS=agent \
SLIPMEM_WIKI_AGENT=/opt/local-synthesizer \
SLIPMEM_WIKI_AGENT_ARGS='["--flag","--model=small"]' \
bun run slipmem -- wiki agent-memory
```

The agent must print `{"sentences":[{"text":"...","noteId":"...","quote":"..."}]}`.
Every sentence needs a selected note ID and an exact supporting quote; anything
unsupported is omitted. The core probes for a working bubblewrap sandbox and
refuses an agent when none is available. `SLIPMEM_WIKI_AGENT_UNSAFE=1` is the
explicit unsafe opt-in to run without that sandbox; it gives the agent your full
user filesystem privileges and should be used only for a reviewed local command.

`--model <id>` is passed to the core adapter registry. The CLI ships no model
providers, so an unregistered ID fails with `synthesis-adapter-unsupported`
instead of calling a guessed service. `--mode extractive` forces the guaranteed
fallback and cannot be combined with `--model`/`--agent`. A synthesized request
never silently downgrades; it fails with an actionable error and writes no page.

`--agent` is tokenized into an argv array and started with `shell: false`.
Quotes group an argument; there is no variable, glob, or command substitution.
Use `--agent-arg=--flag` for arguments that begin with a dash.

## Approvals

Agent writes to permanent notes and all deletes become proposals under
`.slipmem/.state/pending/`. The CLI is a human-only review surface:

```sh
bun run slipmem -- review
bun run slipmem -- approve proposal-20261117203000-ab12cd34
bun run slipmem -- reject proposal-20261117203100-ef56ab78
```

`approve` revalidates the proposal's base content hash. If the note changed
since the proposal was created, approval fails with `stale-base` and does not
touch the note. `reject` removes only the proposal.

## Migration

```sh
# Explicit source
bun run slipmem -- migrate sqlite --db ./legacy.db --dry-run
bun run slipmem -- migrate sqlite --db ./legacy.db
bun run slipmem -- migrate sqlite --db ./legacy.db --merge

# Default source: SLIPMEM_DB_PATH, then $XDG_DATA_HOME/slipmem/slipmem.db
bun run slipmem -- migrate sqlite --dry-run
```

Without `--db`, the CLI resolves `SLIPMEM_DB_PATH` relative to the current
directory, then `$XDG_DATA_HOME/slipmem/slipmem.db` (falling back to
`~/.local/share/slipmem/slipmem.db`). An explicit `--db` always wins. It never
creates the source directory or database, and `:memory:` is rejected because it
is not a file-backed migratable source.

The source database is opened read-only and hashed before and after the run. A
real import copies the source to `.slipmem/.state/migrations/<run>/source-backup.db`,
writes notes through the shared atomic serializer, re-reads every target, and
writes a manifest with counts, hashes, warnings, and malformed rows. A
non-empty target root is refused unless `--merge` is explicit; merge skips notes
already imported by `legacyId`.

Row-level invalid rows are preserved in full under `quarantine/`. A table with
missing required columns is not silently skipped: each row becomes a
quarantineable error. An unsupported object (such as a view) at a note table
name has no rows to read, so it is reported in the plan and manifest without a
row quarantine file.

`source-changed` can happen before notes are written (planning or backup
fingerprint mismatch) or after notes were written (the final fingerprint check).
The report and manifest distinguish the two; the CLI prints `verification: not
run` when the run stopped before writing, and keeps the backup, manifest,
quarantine, and any imported notes when the final check fails.

The human report uses the run-effective `counts.collisions` (not planner-level
collisions), prints each sampled note's actual `targetPath`, and lists interrupted
run manifests. A live owner is reported, never overwritten. JSON output preserves
unsafe SQLite integers and BLOBs as `$bigint`/`$base64` tags instead of rounding
them.

## Read-only legacy compatibility

`legacy list` and `legacy show` expose the retired SQLite rows for one release
without importing them. They share the migration source resolution (`--db`, then
`SLIPMEM_DB_PATH`, then the XDG data database) and the same core read-only
snapshot reader. They never write notes, manifests, quarantine, or repair rows;
`.slipmem/` remains the source of truth. `legacy` does not take `--dir`.

```sh
bun run slipmem -- legacy list --db ./legacy.db --type literature --limit 25
bun run slipmem -- legacy show --db ./legacy.db --type permanent --id legacy-id
bun run slipmem -- legacy list --type permanent --json
```

Both forms print or return the `one-release-read-only` warning. List defaults to
25 rows, caps at 100, and bounds `offset` to 0..100000. Show requires `--type`
because legacy IDs are only unique per table. A missing row exits 1 without
writing. JSON tags unsafe integers and BLOBs the same way the migration manifest
does.

## Initiative tracking (standalone)

Initiative scope, milestones, advisory evidence checks, and per-assertion
promotion live in `@slipmem/core/initiative`. The standalone entry remains
available for handoff and direct use; the root dispatcher can route to the same
`runInitiativeCli` path:

```sh
bun packages/cli/src/main-initiative.ts --help
bun run slipmem -- initiative --help
bun run slipmem -- initiative pin src/feature.ts --kind code --lines 10-20 --json
bun run slipmem -- initiative create --draft initiative.json --json
bun run slipmem -- initiative verify <initiative-id> --json
bun run slipmem -- initiative promote <initiative-id> <assertion-id> --json
bun run slipmem -- initiative project <initiative-id> <assertion-id> --json
bun run slipmem -- initiative reconcile [<initiative-id>] --json
```

Records are durable Markdown files under `.slipmem/initiatives/` with a structured
JSON block. They are not notes, search-index entries, recall candidates, or
approval proposals. A landed promotion can be projected into one permanent note;
that note is ordinary memory after the CLI writes it. An initiative has an
explicit stable ID; a Git branch is never used as its identity.

Verification is advisory. When Git resolves the configured main ref, evidence is
read from the observed commit (not the dirty working tree), and the report says
`verificationMode: "trusted-snapshot"`. Promotion checks that the observed commit
is reachable from that main ref, refuses a non-supported assertion, and is
idempotent on retry. The first slice requires operator-supplied pins and an
explicit per-assertion promotion; it does not run PR checks, infer support, or
promote automatically. Without Git, `verify` discloses `"working-tree"`;
`promote` then requires an explicit `--working-tree` or `--allow-unversioned`
opt-out and skips the permanent-note projection.

When a promotion has a trusted snapshot reachable from the configured main ref,
`promote` also writes one permanent note into the normal flat note store. The
note carries an `initiativeProjection` frontmatter marker with the initiative
scope, promotion snapshot, and supporting evidence pins; its bounded body keeps
the human-readable claim and scope. Unversioned promotions never write to the
main store and report `projection: skipped`. Retries and `reconcile` find the
existing marker note instead of creating a duplicate, and projection never
updates an existing human note: a title collision gets a new suffixed note.
Local `.state/initiative-projections/` receipts are atomic progress markers for
crash recovery, not main knowledge. Projection is invoked only by the explicit
operator `promote`/`project`/`reconcile` path; it adds no automatic agent write
path and does not bypass the MCP approval queue for agent-originated notes.

## Security notes

- Notes are plaintext. Do not store secrets.
- Note text is data. The CLI never executes note content or follows instructions
  found in a note.
- `delete` moves the file to a local trash backup outside `.slipmem/`; it does
  not shred or rewrite Git history.
- Note commands never run Git. `capture git` runs only read-only Git commands
  (`rev-parse`, `cat-file`, `merge-base`, `diff`) against a trusted checkout; it
  never checks out, fetches, resets, commits, pushes, or resolves conflicts.
- The MCP and web wrappers inherit their existing local, unauthenticated
  posture. See `packages/mcp/README.md` and `packages/web/README.md`.
