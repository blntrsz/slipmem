# Repository memory evidence

Status: evidence for the dogfood note set captured at commit `84933b8` on
2026-11-18. This document records the sources and checks behind `.slipmem/`.
It is not a second note source and it does not restate the note bodies.

## Scope and ownership

- Changed paths: `.slipmem/**` and this file only.
- No source, schema, app, or historical evidence document was edited.
- The tags rename had already landed as `2f64eb1` (core), `c81a737` (CLI),
  `6b51240` (MCP), `3f854b8` (server API and web UI), and `8094950` (current
  docs and tour). Notes use the canonical `tags` field.
- `.slipmem/.state/` and the XDG cache are ignored and were not committed.
- Notes were created through `bun run slipmem -- new`, not MCP. The CLI records
  `provenance.source: cli` and `actor: user`.

The user request also supplied the product context: durable notes for domain,
coding standards, service creation, architecture, and Foldkit MVU practice.

## Captured note set

Eight notes: six permanent and two literature.

| ID | Type | Tags | Primary evidence |
| --- | --- | --- | --- |
| `20261118022813-slipmem-is-local-first-markdown-memory` | permanent | `domain`, `architecture`, `storage` | `README.md:3-7`, `README.md:31-61`, `packages/schemas/src/markdown.ts:25-39` |
| `20261118022814-markdown-files-are-the-only-source-of-truth` | permanent | `architecture`, `storage`, `reliability` | `packages/core/src/markdown/paths.ts:25-63`, `atomic.ts:59-157`, `search-index.ts:1197-1223` |
| `20261118022814-architecture-one-repository-three-surfaces` | permanent | `architecture`, `contracts`, `effect` | `packages/server/src/markdown.ts:25-59`, `packages/mcp/src/layer.ts:10-34` |
| `20261118022815-service-cookbook-shape-factory-and-live-layer` | permanent | `coding-standards`, `effect`, `services`, `layers` | `packages/core/src/wiki/wiki-service.ts:75-88,450-459`, `approval-service.ts:153-184,1046-1056` |
| `20261118022816-foldkit-mvu-standards-for-the-web-ui` | permanent | `coding-standards`, `foldkit`, `web` | `packages/web/src/route.ts:5-127`, `packages/web/src/main.ts:49-193,893-1168` |
| `20261118022816-the-local-trust-boundary-is-not-authentication` | permanent | `security`, `approval`, `domain` | `packages/core/src/approval/policy.ts:47-109`, `docs/operator-guide.md:793-849` |
| `20261118022818-source-mvp-plan-principles-architecture-and-security` | literature | `source`, `architecture`, `domain` | `docs/mvp-plan.md` §4, §6, §8, §9, §12 at `8094950` |
| `20261118022819-source-operator-guide-storage-and-trust-boundary` | literature | `source`, `security`, `operations` | `docs/operator-guide.md` §2, §3, §9, §10 at `8094950` |

Literature notes carry a stable repository-relative `reference`:

- `docs/mvp-plan.md §4, §6, §8, §9, §12 (repository commit 8094950)`
- `docs/operator-guide.md §2, §3, §9, §10 (repository commit 8094950)`

## Source checks

The note bodies were written after reading the referenced implementation, not
only the plan. Key confirmations:

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
- `packages/core/src/markdown/search-index.ts` creates the index through
  `Layer.effect` and `Effect.acquireRelease`, and
  `MarkdownSearchIndexFromRepository` takes the root from the repository.
- `packages/core/src/wiki/wiki-service.ts` uses
  `Context.Service<WikiService, WikiServiceShape>()` and `Layer.effect` over
  `MarkdownNoteRepository`.
- `packages/core/src/approval/approval-service.ts` exposes policy-enforced
  `submitMcp` plus human-only `review`, `apply`, and `reject`.
- `packages/core/src/approval/policy.ts` freezes the matrix: human direct; MCP
  fleeting/literature direct; MCP permanent create/update/reclassify pending;
  MCP delete always pending; `direct-unsafe` never bypasses delete.
- `packages/server/src/markdown.ts` wires one repository into index, approval,
  and wiki services with `makeMarkdownLayer`.
- `packages/web/src/main.ts` uses Foldkit `defineMessageUnion`,
  `Command.define`, request IDs, `AsyncData`, `Message.match`, and a pure
  `view`; `packages/web/src/route.ts` defines the route union and parsers.
- `packages/core/src/markdown/check.ts` extracts direct wikilinks and `.md`
  links, rejects traversal and missing IDs, and computes backlinks.

The plan and operator guide still contain historical "topic" prose in places.
The literature notes say so explicitly and defer to current code and README for
the current `tags` vocabulary.

## Commands and observed results

```sh
env -u SLIPMEM_ACTOR bun run slipmem -- init
env -u SLIPMEM_ACTOR bun run slipmem -- new --type permanent \
  --title "..." --tag ... < body
SLIPMEM_EDITOR="python3 /tmp/opencode/slipmem-append-links.py" \
  env -u SLIPMEM_ACTOR bun run slipmem -- edit \
  20261118022813-slipmem-is-local-first-markdown-memory
bun run slipmem -- check --rebuild-index
bun run slipmem -- tags
bun run slipmem -- list --limit 20
bun run slipmem -- search architecture --limit 10
bun run slipmem -- search services --limit 10
bun run slipmem -- wiki architecture --mode extractive --limit 10
bun run slipmem -- wiki coding-standards --mode extractive --limit 10
```

Observed:

- `init` created `/home/dev/src/slipmem/.slipmem` with `.state/`, `README.md`,
  and `.gitignore` containing `.state/`.
- `check --rebuild-index` reported 8 notes, 10 files scanned, 0 errors,
  0 index drift, and an OK result. The two warnings were the expected
  non-note `.slipmem/.gitignore` and `.slipmem/README.md`.
- `tags` counted `architecture` 4, `domain` 3, `coding-standards` 2,
  `effect` 2, `security` 2, `source` 2, `storage` 2, and one each for
  `approval`, `contracts`, `foldkit`, `layers`, `operations`, `reliability`,
  `services`, and `web`.
- `search architecture` returned the architecture permanent note and the MVP
  literature note. `search services` returned the architecture note, the
  service cookbook, and the MVP literature note.
- `wiki architecture` cited four notes by ID and file path. `wiki
  coding-standards` cited the Foldkit note and the service cookbook by ID and
  file path.
- The only inter-note links are in the domain note:
  `[[20261118022814-markdown-files-are-the-only-source-of-truth]]` and
  `[[20261118022816-the-local-trust-boundary-is-not-authentication]]`. Both
  targets exist, so `check` reports no broken or unsafe link.
- All eight notes predate this evidence file and pass `check` with canonical
  `tags` frontmatter. The flat root contains no topic/type folders.

## Deliberate exclusions

- No secrets, credentials, tokens, personal data, process IDs, temporary
  draft paths, index paths, or cache contents were copied into notes.
- No generated wiki page was persisted as a note.
- No `.state/`, cache database, log, or generated tour output was committed.
