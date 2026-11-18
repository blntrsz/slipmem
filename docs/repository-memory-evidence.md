# Repository memory evidence

Status: evidence for the dogfood note set in `.slipmem/`, corrected and then
expanded with separate domain reference notes on 2026-11-18. This document
records the sources and checks behind the notes. It is not a second note source
and does not restate the note bodies. Domain-note details are in
[`docs/domain-memory-evidence.md`](domain-memory-evidence.md).

## Baseline and scope

- Code baseline: **`1d5a7a4`** (`Treat a null tags field as absent in legacy
  parsing`). This is the last code fix in the tags review and the tree the
  notes were checked against. The first evidence pass named `84933b8`, which
  is docs-only and predates the parser fix; that baseline was wrong. The domain
  expansion was authored against tree `ca449a6`; no application code changed,
  so the code baseline remains `1d5a7a4`.
- The tour/docs snapshot is `8094950`. The live plan later moved to canonical
  `tags` in `7cbc446`.
- This expansion changes `.slipmem/**`, this file, and
  `docs/domain-memory-evidence.md`. The earlier correction also touched
  `docs/repository-memory-review-fixes.md`.
- No source, schema, app, test, or historical evidence document was edited.
- `.slipmem/.state/` and the XDG cache are ignored and were not committed.
- The original notes were rewritten through `bun run slipmem -- edit` with a
  temporary editor helper. IDs, `createdAt`, titles, tags, and
  `provenance.source: cli` / `actor: user` were preserved; the repository
  advanced `updatedAt`. The eight domain notes were created through
  `bun run slipmem -- new` with repeated `--tag`.
- The current plan is canonical `tags`; the two literature notes pin `8094950`,
  the source snapshot they summarize. Their `reference` metadata is now a
  commit-pinned GitHub URL rather than a repository-relative path.

## Captured note set

The original set has eight notes: six permanent and two literature.

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

The domain expansion adds eight permanent notes, one file per implemented
domain: fleeting notes, permanent notes, literature notes, tags, approvals and
proposals, cited wiki, search and index, and note identity and lifecycle. The
`.slipmem/README.md` domain map links them. They are documentation notes whose
type is permanent; a note about fleeting notes is not itself fleeting.

Literature notes carry a commit-pinned GitHub `reference`:

- `https://github.com/blntrsz/slipmem/blob/8094950/docs/mvp-plan.md §4, §6, §8, §9, §12`
- `https://github.com/blntrsz/slipmem/blob/8094950/docs/operator-guide.md §2, §3, §9, §10`

Both pins are valid commits. They preserve what the note actually read even
though the live plan now uses `tags`. The body links use the same commit pin,
while implementation evidence links use the repository's `main` branch.

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

## Domain expansion

- Eight separate permanent documentation notes now cover one implemented
  domain each: fleeting notes, permanent notes, literature notes, tags,
  approvals and proposals, cited wiki, search and index, and note identity and
  lifecycle. `.slipmem/README.md` is the non-note domain map.
- A domain's subject does not set its note type. The fleeting, permanent, and
  literature domain notes are all `type: permanent` because they are durable
  documentation, not inbox captures or external-source summaries.
- Every wikilink and plain source-code evidence path in `.slipmem/**` was
  replaced with a Markdown link. Cross-note links, including the README domain
  map, use actual HTTPS URLs of the form
  `https://github.com/blntrsz/slipmem/blob/main/.slipmem/<id>.md` with readable
  labels. Source links target
  `https://github.com/blntrsz/slipmem/blob/main/...`; the two literature
  sources use the `8094950` commit pin.
- Cross-note URLs are external to the local note graph, so `check` does not
  resolve them and they add no backlinks. This is deliberate because the
  request was for actual GitHub links, and app linking and backlink behavior
  was not changed. These URLs resolve after this work is pushed; it has not
  been pushed.
- No wikilink syntax remains anywhere under `.slipmem/`, including the
  generated starter README.

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
bun run slipmem -- new --type permanent --title "Domain: <domain>" \
  --tag domain --tag <domain-tag> < /tmp/opencode/domain-notes/<domain>.md
bun run slipmem -- check --rebuild-index
bun run slipmem -- tags
bun run slipmem -- search "domain fleeting" --limit 10
bun run slipmem -- search "approval proposal" --limit 10
bun run slipmem -- wiki domain --mode extractive --limit 10 --json
```

The temporary editor helper copied the prepared full note over the CLI draft;
the CLI then parsed, validated, and wrote it atomically. The new notes were
normal `slipmem new` writes from stdin. No note was edited by direct file
overwrite.

Observed:

- Sixteen bodies are within the 2000/5000 limits: permanent bodies range from
  1578 to 1999 characters, and the two literature bodies are 3671 and 3942.
  The code block extracted from the service note remains 1204 characters.
- `check --rebuild-index` reported 16 notes, 18 files scanned, 0 errors,
  0 index drift, and OK. The two warnings were the expected non-note
  `.slipmem/.gitignore` and `.slipmem/README.md`.
- `tags` counted `domain` 11, `architecture` 4, `lifecycle` 3, `security` 3,
  `source` 3, `storage` 3, `approval` 2, `coding-standards` 2, `effect` 2, and
  one each for `contracts`, `fleeting`, `foldkit`, `identity`, `index`,
  `layers`, `literature`, `operations`, `permanent`, `reliability`, `search`,
  `services`, `tags`, `web`, and `wiki`.
- `search "domain fleeting"` returned eight notes, led by the fleeting,
  literature, and permanent domain notes. `search "approval proposal"` returned
  five notes, led by the approvals domain note.
- `wiki domain --mode extractive --limit 10` cited ten notes by ID and
  `.slipmem/<filename>` path, including all eight domain notes and the trust
  and plan notes.
- A link audit counted 79 `main`-branch GitHub links (53 evidence links plus 26
  cross-note links), 2 commit-pinned GitHub links, and 0 local note-link
  destinations. Every `main` target is a tracked file, both pins exist at
  `8094950`, and every cross-note target exists under `.slipmem/`.

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
