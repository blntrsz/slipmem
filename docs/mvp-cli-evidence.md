# CLI Phase 2 evidence

Date: 2026-11-18

Status: **Phase 2 CLI implemented and tested against the shared Markdown core.**
Authority: [`docs/mvp-plan.md`](./mvp-plan.md), section 7.1 and Phase 2.

This note is the CLI workstream's coordination point. The shared implementation
log was owned by the core/Phase 1 workers and is intentionally not edited here.

## Scope and ownership

- New workspace package: `packages/cli` (`@slipmem/cli`).
- All note writes, parsing, filename rules, search, wiki assembly, migration,
  and proposal handling come from `@slipmem/core` and `@slipmem/schemas`.
- No core, schema, server, MCP, or web source was edited by this workstream.
- `bun.lock` has one additive `packages/cli` workspace stanza. No new
  third-party dependency was added; the CLI uses `@slipmem/core`,
  `@slipmem/schemas`, and `effect` from existing workspace/catalog entries.
- Root `package.json` adds only:
  `"slipmem": "bun packages/cli/src/main.ts"`.

## Commands

`packages/cli/src/cli.ts` dispatches strict commands; `packages/cli/src/args.ts`
rejects unknown, duplicate, and malformed options before any core call.

| Command | Core API used | Notes |
| --- | --- | --- |
| `init` | `resolveNoteRoot`, `initializeNoteRoot` | Idempotent; creates `.state/`, README, `.gitignore`. |
| `new` | `MarkdownNoteRepository.create` | Content from `--content`, stdin, or editor body draft. Provenance `source: cli`, actor `SLIPMEM_ACTOR` or `user`. |
| `list` | `MarkdownNoteRepository.listNotes` | Type/topic filters; default 10, maximum 50. |
| `show` | `MarkdownNoteRepository.get` | Metadata, body, file citation; typed not-found. |
| `edit` | `parseMarkdownNote`, `MarkdownNoteRepository.update` | Full-note temporary draft outside the root; validates before the repository's atomic write. |
| `delete` | `MarkdownNoteRepository.delete` | Moves to the per-root trash backup. Non-interactive use requires `--yes`. |
| `search` | `makeMarkdownSearchIndex` refresh + search | Bounded ranked results, excerpt window, type/topic filters. |
| `topics` | `MarkdownSearchIndex.listTopics` | Counts and optional query. |
| `check` | `checkNoteRoot`, index snapshot/rebuild | Errors exit 1; warnings do not. `--rebuild-index` is the recovery path. |
| `wiki` | `makeWikiService` extractive mode | Cited sections; excludes fleeting unless `--include-fleeting`; `--out` must be outside the root. |
| `migrate` | `importMigration` (planner + importer) | Dry run writes nothing; real import backs up, verifies, writes manifest, refuses non-empty root without `--merge`. |
| `review` | `makeApprovalService.review` | Human-only; summaries, diffs, stale/expired flags. |
| `approve` | `makeApprovalService.apply` | Revalidates base hash/expiry; stale proposals fail without writing. |
| `reject` | `makeApprovalService.reject` | Removes only the proposal. |
| `mcp` / `web` | Existing entrypoints | Thin process wrappers with inherited stdio/environment. |

All commands support `--json` and `--dir <path>`. Exit statuses are `0`
success, `1` validation/operational/migration failure, and `2` usage or an
explicitly unavailable feature.

## Editor and write safety

- `edit` writes the current full note to a `mkdtemp` directory outside the note
  root, opens `SLIPMEM_EDITOR` / `VISUAL` / `EDITOR`, parses the saved draft with
  the real note contract, then calls `repository.update`.
- Invalid frontmatter, wrong ID/type/reference, conflict markers, oversized
  bodies, and timestamp tampering leave the original file untouched. Managed
  metadata (`createdAt`, `updatedAt`, `id`, unknown frontmatter, `legacyId`,
  `aliases`) cannot be edited through the draft and produces an explicit error.
- New notes from an editor use a temporary body draft and the same repository
  validation/atomic create path.
- The CLI does not implement a second serializer, parser, lock, or index.

## Explicit boundaries

- **Synthesized CLI wiki is unavailable, not faked.** `--mode synthesized`,
  `--model`, and `--agent` exit 2 with `synthesis-unavailable` and write
  nothing. The shared `WikiService` now supports synthesis, but exposing model
  adapter configuration through the CLI is a later increment. Extractive mode
  is fully implemented.
- **MCP/web wrappers are thin.** They start the existing entrypoints and are
  not re-verified by CLI acceptance tests; those surfaces have their own tests.
- **No CLI approval bypass.** `review`, `approve`, and `reject` use only the
  human approval service; no MCP tool is added or changed.
- **No Git automation.** No command commits, pushes, resets, or resolves
  conflicts.

## Verification

Disposable roots were used under `/tmp/opencode`; no test depends on a real
home directory, database, or network.

CLI suite:

```text
$ bun test packages/cli
 34 pass
 0 fail
 304 expect() calls
Ran 34 tests across 9 files.
```

Full repository gate:

```text
$ bun run lint
(no findings)

$ bunx tsc --noEmit
(no errors)

$ bun test
 272 pass
 0 fail
 1949 expect() calls
Ran 272 tests across 34 files.

$ bun run check
(lint, typecheck, 272 tests, and web client/SSR build all pass)
```

Root script smoke test:

```text
$ bun run slipmem -- init --dir /tmp/.../.slipmem
$ bun run slipmem -- new --dir /tmp/.../.slipmem --type fleeting \
    --title "Smoke note" --content "Smoke body"
$ bun run slipmem -- list --dir /tmp/.../.slipmem
ID                         TYPE      UPDATED              TITLE
20261117230413-smoke-note  fleeting  2026-11-17T23:04:13Z  Smoke note
```

Acceptance coverage in `packages/cli/src/*.test.ts`:

- `init.test.ts`: root creation/idempotence, help, usage exit 2, JSON errors,
  flat layout.
- `args.test.ts`: option forms, repeatable lists, positional bounds, `--`.
- `notes.test.ts`: create from flags/stdin, literature reference and body
  limits, list/show/filter/missing, editor edit success, invalid draft
  atomicity, no-op edits, managed timestamps, no editor configured.
- `search.test.ts`: refreshed FTS5 search, type/topic/limit filters, excerpts,
  topics counts/query, check clean/error/rebuild, external edit visibility.
- `wiki.test.ts`: cited extractive page, fleeting opt-in, limit, empty result,
  `--out` outside root, refusal inside root, synthesis unavailable.
- `migrate.test.ts`: dry run writes nothing and source bytes unchanged, real
  import with backup/manifest/verification, non-empty refusal, merge
  idempotency, malformed-row preservation, missing source, unknown kind.
- `approval.test.ts`: review diff, approve permanent create, reject, stale-base
  refusal, delete-through-proposal backup, missing proposal, `delete --yes`
  confirmation.
- `workflow.test.ts`: the clean-root local loop through the root script.

## Commit boundaries

| Commit | Increment |
| --- | --- |
| `f032517` | Workspace/package, root script, strict argument parser, help, `init` |
| `4947344` | `new`, `list`, `show`, editor-backed `edit`, note output |
| `80232f9` | `search`, `topics`, `check`, index integration |
| `ccd3504` | Basic extractive wiki |
| `7c79865` | SQLite dry run + verified import + merge reporting |
| `925f622` | Refactor CLI wiki to the shared core `WikiService` |
| `df9466a` | `review`, `approve`, `reject` over the approval service |
| `3cd3942` | Confirmed `delete` with trash backup |
| `955ee07` | MCP/web wrappers, CLI README, acceptance workflow |

## API blockers / follow-ups

No blocking API gap remains for Phase 2. The core Markdown repository, index,
migration importer, wiki service, and approval service all landed while this
workstream was in progress; later CLI commits consume those shared APIs.

Optional follow-ups outside this phase:

- Expose core synthesized-wiki configuration (`--model`/`--agent` plus a model
  adapter registry) through the CLI when the product chooses a default.
- Allow editing unknown frontmatter keys through `edit` once the repository has
  a supported unknown-key write input; today they are preserved but read-only.
- Add an end-to-end wrapper test once MCP/web entrypoints stabilize their
  environment contracts.
