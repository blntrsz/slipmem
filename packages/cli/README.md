# @slipmem/cli

The `slipmem` command is the reference human interface to a flat Markdown note
repository under `.slipmem/`. It uses the shared `@slipmem/core` Markdown
repository, disposable search index, migration importer, wiki service, and
approval service. It does not maintain a second store or a type directory.

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
| `list [--type <type>] [--topic <topic>] [--limit <n>]` | Bounded list with IDs, types, titles, and updated times. |
| `show <id>` | Print metadata, body, and the file path. |
| `edit <id>` | Open a full-note temporary draft, validate on save, then write atomically. |
| `delete <id>` | Move one note to the local trash backup. Requires `--yes` when non-interactive. |
| `search <query> [--type <type>] [--topic <topic>] [--limit <n>]` | Refresh the disposable index, then run bounded ranked search. |
| `topics [--query <topic>] [--limit <n>]` | List derived topic slugs and note counts. |
| `check [--rebuild-index]` | Validate filenames, metadata, limits, duplicate IDs, conflict markers, non-note files, and index drift. |
| `wiki <topic> [--limit <n>] [--include-fleeting] [--out <path>]` | Build an on-demand extractive topic page through the shared wiki service. |
| `review` | List pending agent proposals with summaries, diffs, and stale/expired flags. |
| `approve <proposal-id>` | Apply a proposal after revalidating its base hash, expiry, and note rules. |
| `reject <proposal-id>` | Remove a proposal without changing any note. |
| `migrate sqlite --db <path> [--dry-run] [--merge]` | Plan or import legacy SQLite notes with a verified backup and manifest. |
| `mcp` / `web` | Thin wrappers around the existing MCP and web entry points. |

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

## Search, topics, check, and index

The search index lives outside the note root under
`$XDG_CACHE_HOME/slipmem/index/<root-hash>/` and is disposable. `search` and
`topics` refresh it before reading, so an editor change is visible without a
manual import. `check --rebuild-index` is the recovery path when the index is
missing or stale.

`check` never renames, repairs, or resolves anything. Errors make it exit `1`;
warnings such as non-note files or slug drift do not.

## Wiki boundary

`slipmem wiki` uses the shared core wiki service in extractive mode: permanent
and literature notes are selected by normalized topic, each excerpt is quoted
verbatim, and every section carries a note ID and file citation. Fleeting notes
are excluded unless `--include-fleeting` is passed. `--out` must point outside
`.slipmem/`; the default is stdout.

Synthesized mode, `--model`, and `--agent` are currently reported as unavailable
through the CLI. The CLI does not silently downgrade a synthesized request and
writes no page.

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
bun run slipmem -- migrate sqlite --db ./legacy.db --dry-run
bun run slipmem -- migrate sqlite --db ./legacy.db
bun run slipmem -- migrate sqlite --db ./legacy.db --merge
```

The source database is opened read-only and hashed before and after the run. A
real import copies the source to `.slipmem/.state/migrations/<run>/source-backup.db`,
writes notes through the shared atomic serializer, re-reads every target, and
writes a manifest with counts, hashes, warnings, and malformed rows. Malformed
rows are reported and quarantined, never truncated or silently dropped. A
non-empty target root is refused unless `--merge` is explicit; merge skips notes
already imported by `legacyId`.

## Security notes

- Notes are plaintext. Do not store secrets.
- Note text is data. The CLI never executes note content or follows instructions
  found in a note.
- `delete` moves the file to a local trash backup outside `.slipmem/`; it does
  not shred or rewrite Git history.
- The CLI never runs Git commands, commits, pushes, or resolves conflicts.
- The MCP and web wrappers inherit their existing local, unauthenticated
  posture. See `packages/mcp/README.md` and `packages/web/README.md`.
