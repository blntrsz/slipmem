# CLI Phase 2 evidence

Date: 2026-11-18

Status: **Phase 2 CLI implemented and tested against the shared Markdown core,
including synthesized wiki mode and working MCP/web launch wrappers.**
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
| `wiki` | `makeWikiService` extractive or synthesized | Cited sections; excludes fleeting unless `--include-fleeting`; `--agent` runs an argv array without a shell; `--model` needs a core adapter; `--out` is real-path guarded outside the root. |
| `migrate` | `importMigration` (planner + importer) | Dry run writes nothing; real import backs up, verifies, writes manifest, refuses non-empty root without `--merge`. |
| `review` | `makeApprovalService.review` | Human-only; summaries, diffs, stale/expired flags. |
| `approve` | `makeApprovalService.apply` | Revalidates base hash/expiry; stale proposals fail without writing. |
| `reject` | `makeApprovalService.reject` | Removes only the proposal. |
| `mcp` / `web` | Existing entrypoints | Thin process wrappers with inherited stdio, the caller's cwd, and the resolved note root passed as `SLIPMEM_DIR`. |

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

## Synthesized wiki

`wiki` is no longer extractive-only. The CLI resolves `--mode`, `--model`,
`--agent`, and `--agent-arg` into the shared `makeWikiService` config/environment
contract; it does not contain a second synthesizer.

- `--agent` is tokenized into an executable plus argv and started with
  `shell: false`. Quotes group tokens; there is no expansion, globbing, or
  command substitution. Extra arguments that begin with `-` use
  `--agent-arg=--flag` or the quoted command form.
- The core passes only the bounded selected notes as JSON on stdin, requires an
  exact supporting quote for each sentence, and drops unsupported sentences
  before rendering.
- The core probes bubblewrap before running an agent. A failed probe fails
  closed; `SLIPMEM_WIKI_AGENT_UNSAFE=1` is the documented unsafe opt-in and is
  preserved from the caller's environment. The CLI does not invent a weaker
  sandbox.
- `--model <id>` is forwarded to the core adapter registry. The CLI registers no
  model providers, so an arbitrary model ID fails with
  `synthesis-adapter-unsupported` instead of contacting a guessed service.
- `SLIPMEM_WIKI_SYNTHESIS` still selects the default mode. `--mode extractive`
  forces the guaranteed fallback and conflicts with `--model`/`--agent`.
- `--out` is resolved through its parent's real path. A missing parent, a
  symlinked parent into the note root, or an existing output symlink into the
  root is rejected before the atomic write.

## Explicit boundaries

- **MCP/web wrappers are thin but verified.** Launch tests start the real MCP
  stdio server from a disposable cwd outside the repository, complete an MCP
  initialize handshake with `--dir`, and launch the real Vite entry point with
  forwarded argv. The web wrapper is the Vite development host, not the
  production `web:serve` process.
- **No CLI approval bypass.** `review`, `approve`, and `reject` use only the
  human approval service; no MCP tool is added or changed.
- **No Git automation.** No command commits, pushes, resets, or resolves
  conflicts.
- **Migration reporting is phase-truthful.** A pre-write failure prints
  `verification: not run`; a post-write `source-changed` keeps imported notes,
  backup, manifest, and quarantine and says so in the operator guide. The human
  report marks verification OK only when `verified` is true, shows
  `counts.collisions` as the effective count rather than planner-level
  collisions, prints each skipped note's actual target path, lists interrupted
  run manifests, and JSON output tags unsafe integers and blobs as `$bigint` and
  `$base64` instead of rounding or failing serialization.

## Verification

Disposable roots were used under `/tmp/opencode`; no test depends on a real
home directory, database, or network.

CLI suite:

```text
$ bun test packages/cli
 45 pass
 0 fail
 383 expect() calls
Ran 45 tests across 12 files.
```

Full repository gate:

```text
$ bun run lint
(no findings)

$ bunx tsc --noEmit
(no errors)

$ bun test
 341 pass
 0 fail
 2859 expect() calls
Ran 341 tests across 40 files.

$ bun run check
(lint, typecheck, 341 tests, and web client/SSR build all pass)
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
- `agent-command.test.ts`: quoted argv, no shell expansion/chaining, escapes,
  unterminated quotes, empty commands.
- `notes.test.ts`: create from flags/stdin, literature reference and body
  limits, list/show/filter/missing, editor edit success, invalid draft
  atomicity, no-op edits, managed timestamps, no editor configured.
- `search.test.ts`: refreshed FTS5 search, type/topic/limit filters, excerpts,
  topics counts/query, check clean/error/rebuild, external edit visibility.
- `wiki.test.ts`: cited extractive page, fleeting opt-in, limit, empty result,
  `--out` outside root, refusal inside root (including symlinked parents and
  missing parents), configured agent synthesis over argv, environment-selected
  synthesis, explicit extractive override, unconfigured/model-adapter failures,
  and mutually exclusive options.
- `migrate.test.ts`: dry run writes nothing and source bytes unchanged, real
  import with backup/manifest/verification, non-empty refusal with `verification:
  not run`, merge idempotency with actual skipped target paths and zero effective
  collisions, interrupted-run reporting, tagged unsafe integers/blobs in JSON,
  malformed-row preservation, missing source, unknown kind.
- `portable-json.test.ts`: `$bigint`, `$base64`, and `$number` tags with no
  rounding or loss.
- `approval.test.ts`: review diff, approve permanent create, reject, stale-base
  refusal, delete-through-proposal backup, missing proposal, `delete --yes`
  confirmation.
- `wrappers.test.ts`: real MCP initialize handshake with `--dir` and a real Vite
  entry-point launch with forwarded argv, both from a cwd outside the repository.
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
| `46eff30` | Working MCP/web wrappers from any cwd, with real launch tests |
| `df90921` | Synthesized wiki through the shared service; `--out` real-path guard |
| `ee6705a` | Truthful migration verification status before any write |
| `84d02ab` | Effective collisions, actual skipped paths, interrupted-run report, portable JSON tags |
| `598e14f` | CLI README and operator/evidence documentation refresh |

## API blockers / follow-ups

No blocking API gap remains for Phase 2. The core Markdown repository, index,
migration importer, wiki service, and approval service all landed while this
workstream was in progress; later CLI commits consume those shared APIs.

Optional follow-ups outside this phase:

- Ship a documented default model adapter registry if the product selects one.
  Today `--model` is correctly forwarded but fails closed without an adapter.
- Allow editing unknown frontmatter keys through `edit` once the repository has
  a supported unknown-key write input; today they are preserved but read-only.
- Add a `cache clear` command if operators find the manual cache removal too
  error-prone; the current documented path is `check --rebuild-index` or manual
  removal.
