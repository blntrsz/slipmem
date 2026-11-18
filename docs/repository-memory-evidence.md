# Repository memory evidence

Status: evidence for the dogfood note set in `.slipmem/`, corrected on
2026-11-18. This document records the sources and checks behind the notes. It is
not a second note source and does not restate the note bodies.

## Baseline and scope

- Code baseline: **`1d5a7a4`** (`Treat a null tags field as absent in legacy
  parsing`). This is the last code fix in the tags review and the tree the
  notes were checked against. The first evidence pass named `84933b8`, which
  is docs-only and predates the parser fix; that baseline was wrong.
- The tour/docs snapshot is `8094950`. The live plan later moved to canonical
  `tags` in `7cbc446`.
- Changed paths: `.slipmem/**`, this file, and
  `docs/repository-memory-review-fixes.md`.
- No source, schema, app, test, or historical evidence document was edited.
- `.slipmem/.state/` and the XDG cache are ignored and were not committed.
- The notes were rewritten through `bun run slipmem -- edit` with a temporary
  editor helper. IDs, `createdAt`, titles, tags, and
  `provenance.source: cli` / `actor: user` were preserved; the repository
  advanced `updatedAt`.
- The current plan is canonical `tags`; the two literature notes intentionally
  pin `8094950`, the source snapshot they summarize.

## Captured note set

Eight notes: six permanent and two literature.

| ID | Type | Tags | Primary evidence |
| --- | --- | --- | --- |
| `20261118022813-slipmem-is-local-first-markdown-memory` | permanent | `domain`, `architecture`, `storage` | `README.md:3-7`, `README.md:31-61`, `packages/schemas/src/markdown.ts:25-39` |
| `20261118022814-markdown-files-are-the-only-source-of-truth` | permanent | `architecture`, `storage`, `reliability` | `packages/core/src/markdown/paths.ts:25-63`, `atomic.ts:59-157`, `search-index.ts:1197-1223` |
| `20261118022814-architecture-one-repository-three-surfaces` | permanent | `architecture`, `contracts`, `effect` | `packages/server/src/markdown.ts:25-59`, `packages/mcp/src/layer.ts:10-34` |
| `20261118022815-service-cookbook-shape-factory-and-live-layer` | permanent | `coding-standards`, `effect`, `services`, `layers` | `packages/core/src/wiki/wiki-service.ts:75-88,158-162,450-459`, `packages/core/src/markdown/repository.ts:159-163,517-519,797-800` |
| `20261118022816-foldkit-mvu-standards-for-the-web-ui` | permanent | `coding-standards`, `foldkit`, `web` | `packages/web/src/route.ts:12-159`, `packages/web/src/main.ts:133-218,909-1355` |
| `20261118022816-the-local-trust-boundary-is-not-authentication` | permanent | `security`, `approval`, `domain` | `packages/core/src/approval/policy.ts:47-109`, `docs/operator-guide.md:793-849` |
| `20261118022818-source-mvp-plan-principles-architecture-and-security` | literature | `source`, `architecture`, `domain` | `docs/mvp-plan.md` §4, §6, §8, §9, §12 at `8094950` |
| `20261118022819-source-operator-guide-storage-and-trust-boundary` | literature | `source`, `security`, `operations` | `docs/operator-guide.md` §2, §3, §9, §10 at `8094950` |

Literature notes carry a stable repository-relative `reference`:

- `docs/mvp-plan.md §4, §6, §8, §9, §12 (repository commit 8094950)`
- `docs/operator-guide.md §2, §3, §9, §10 (repository commit 8094950)`

Both pins are valid commits. They preserve what the note actually read even
though the live plan now uses `tags`.

## Review corrections

The findings and per-note changes are recorded in
`docs/repository-memory-review-fixes.md`. In summary:

- The service cookbook is now a self-contained, compilable Effect v4 example.
  It imports `Context`, `Data`, `Effect`, and `Layer`, defines `NoteError`,
  `StoreShape`, `NoteStore`/`Store` tag, `ReaderConfig`, `ReaderShape`, a real
  `read` closure, and a Live layer. The old undefined `read` and undeclared
  `Thing*`/`MarkdownNoteRepository` placeholders are gone.
- The Foldkit note no longer claims every async result has a request-ID guard.
  Loading, save, delete, search, tags, wiki, pending, and health paths do;
  approve/reject deliberately do not, because they ignore the result ID and
  trigger a fresh pending load. `Effect.Schema.Struct` was corrected to
  `Schema.Struct`.
- Domain and plan notes now say only reclassification **to or from permanent**
  is pending. Fleeting ↔ literature reclassification is direct.
- Architecture and operator notes now say `tags` plus `topics` is rejected
  only when both are non-null. `tags: null` is absent, so a `topics` list still
  loads.

## Source checks

- `packages/schemas/src/markdown.ts` defines `NOTE_TYPES`, `CONTENT_LIMITS`
  (1000/2000/5000), `MAX_TAG_LENGTH`, slug helpers, `NoteMetadata`, and the
  literature `reference` rule.
- `packages/core/src/markdown/errors.ts` defines `MarkdownError` as a
  `Data.TaggedError` with `code`, `area`, `path`, optional `field`, and
  `message`.
- `packages/core/src/markdown/atomic.ts` writes a same-directory temp file,
  fsyncs, renames for overwrite, and uses a hard link for create-only writes.
- `packages/core/src/markdown/repository.ts` exposes a `Context.Service` shape
  and builds it with `makeMarkdownNoteRepository` plus
  `MarkdownNoteRepositoryLive`; update/delete compare an expected content hash.
- `packages/core/src/markdown/note-document.ts:287-320` reads `tags` and
  legacy `topics` as one field. It rejects only when both are non-null, and
  treats `null` as absent; the next write emits `tags`.
- `packages/core/src/wiki/wiki-service.ts` uses
  `Context.Service<WikiService, WikiServiceShape>()`, a factory with a config
  parameter and a `read`/`select` closure, and `Layer.effect` over
  `MarkdownNoteRepository`.
- `packages/core/src/approval/policy.ts:47-81` freezes the matrix: human
  direct; MCP fleeting/literature direct; MCP permanent create/update and
  reclassification to or from permanent pending; MCP delete always pending;
  `direct-unsafe` never bypasses delete.
- `packages/web/src/main.ts` uses `Schema.Struct` for `Model`, request counters
  per async surface, `defineMessageUnion`, `AsyncData`, and guarded
  `Succeeded*`/`Failed*` cases. `SucceededApprove`/`SucceededReject` deliberately
  ignore their request ID and reload pending.
- `packages/server/src/markdown.ts` wires one repository into index, approval,
  and wiki services with `makeMarkdownLayer`.

## Commands and observed results

```sh
env -u SLIPMEM_ACTOR SLIPMEM_EDITOR=/tmp/opencode/note-rewrites/replace-note.sh \
  SLIPMEM_REPLACEMENT=/tmp/opencode/note-rewrites/replacements/<id>.md \
  bun run slipmem -- edit <id> --json
bun run slipmem -- check --rebuild-index
bun run slipmem -- tags
bun run slipmem -- search architecture --limit 10
bun run slipmem -- search services --limit 10
bun run slipmem -- wiki architecture --mode extractive --limit 10
bun run slipmem -- wiki coding-standards --mode extractive --limit 10
```

The temporary editor helper copied the prepared full note over the CLI draft;
the CLI then parsed, validated, and wrote it atomically. No note was edited by
direct file overwrite.

Observed:

- Six permanent bodies are 1752, 1964, 1990, 1929, 1945, and 1988
  characters. Both literature bodies are 3876 and 3599. All are within
  2000/5000 limits; the code block extracted from the service note is 1205
  characters.
- `check --rebuild-index` reported 8 notes, 10 files scanned, 0 errors,
  0 index drift, and OK. The two warnings were the expected non-note
  `.slipmem/.gitignore` and `.slipmem/README.md`.
- `tags` counted `architecture` 4, `domain` 3, `coding-standards` 2,
  `effect` 2, `security` 2, `source` 2, `storage` 2, and one each for
  `approval`, `contracts`, `foldkit`, `layers`, `operations`, `reliability`,
  `services`, and `web`.
- `search architecture` returned four notes, led by the architecture permanent
  note and the MVP literature note. `search services` returned the service
  cookbook, the architecture note, and the MVP literature note.
- `wiki architecture` cited four notes by ID and path. `wiki
  coding-standards` cited the Foldkit note and the service cookbook by ID and
  path, including the compilable code block.
- The only inter-note links remain in the domain note:
  `[[20261118022814-markdown-files-are-the-only-source-of-truth]]` and
  `[[20261118022816-the-local-trust-boundary-is-not-authentication]]`. Both
  targets exist, so `check` reports no broken link.

## Compile and runtime proof

The fenced TypeScript was extracted from the saved note and compiled with the
workspace TypeScript 7.0.2 against workspace `effect` 4.1.4:

```sh
mkdir -p /tmp/opencode/cookbook-22815/node_modules
ln -s /home/dev/src/slipmem/node_modules/.bun/effect@4.1.4/node_modules/effect \
  /tmp/opencode/cookbook-22815/node_modules/effect
# snippet.ts is the exact note code block; tsconfig is strict, noEmit
/home/dev/src/slipmem/node_modules/.bin/tsc -p /tmp/opencode/cookbook-22815/tsconfig.json
# exit 0
bun /tmp/opencode/cookbook-22815/runtime.ts
# {"direct":"p:body:a","throughLayer":"p:body:b"}
```

The runtime harness called `makeReader` directly and resolved `Reader` through
`ReaderLive` with `Layer.succeed(Store, ...)` and `Layer.provide`. Both paths
returned the prefixed body, proving the `read` closure and Live layer are real,
not placeholders.

## Deliberate exclusions

- No secrets, credentials, tokens, personal data, process IDs, temporary draft
  paths, index paths, or cache contents were copied into notes.
- No generated wiki page was persisted as a note.
- No `.state/`, cache database, log, or generated tour output was committed.
