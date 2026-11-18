# Repository memory review fixes

Date: 2026-11-18. Scope: `.slipmem/**`,
`docs/repository-memory-evidence.md`, and this document only. No application
fixes are included.

## Findings and corrections

| Note | Finding | Correction |
| --- | --- | --- |
| `20261118022815-service-cookbook-shape-factory-and-live-layer` | Code returned an undefined `read`; `ThingError`, `ThingShape`, `ThingRepository`, `ThingConfig`, and `MarkdownNoteRepository` were undeclared placeholders. Body was 1992, almost the 2000 limit. | Replaced with a 1929-character self-contained example: `NoteError`, `StoreShape`, `Store` tag, `ReaderConfig`, `ReaderShape`, a real `read` closure, `makeReader`, and `ReaderLive`. Imports `Context`, `Data`, `Effect`, and `Layer`. Verified with `tsc` and a runtime layer test. |
| `20261118022816-foldkit-mvu-standards-for-the-web-ui` | Claimed every async `Succeeded*`/`Failed*` result used the request-ID guard. | Loading, save, delete, search, tags, wiki, pending, and health results are guarded. Approve/reject deliberately ignore their request ID, bump `pendingRequestId`, and reload pending. Changed `Effect.Schema.Struct` to `Schema.Struct`; refreshed route and main pointers. |
| `20261118022813-slipmem-is-local-first-markdown-memory` | Said all agent reclassification waits for approval. | Only reclassification to or from `permanent` is pending; reclassification between `fleeting` and `literature` is direct. |
| `20261118022818-source-mvp-plan-principles-architecture-and-security` | Same overbroad reclassification claim. | Applied the same precise rule. Kept the literature reference pinned to the `8094950` snapshot and said the live plan is updated. |
| `20261118022814-architecture-one-repository-three-surfaces` | Said `tags` plus `topics` is rejected whenever both keys exist. | It is rejected only when both are non-null. `tags: null` is absent, so the legacy `topics` list still loads. |
| `20261118022819-source-operator-guide-storage-and-trust-boundary` | Same both-keys wording; approval sentence was too broad. | Clarified the non-null rule and `tags: null` compatibility. Narrowed pending approval to permanent creates/updates and reclassification to or from permanent; fleeting ↔ literature is direct, deletes pending. |
| `docs/repository-memory-evidence.md` | Named `84933b8`, a docs-only commit, as the code baseline. | Corrected to `1d5a7a4`, the parser fix that treats `tags: null` as absent. Kept `8094950` as the literature snapshot pin because it is the source actually read; noted the live plan moved to `tags` in `7cbc446`. |

## Editing method

The notes were not rewritten with shell redirection. Each note was prepared as
a full document with its existing frontmatter and passed through the real CLI:

```sh
env -u SLIPMEM_ACTOR \
  SLIPMEM_EDITOR=/tmp/opencode/note-rewrites/replace-note.sh \
  SLIPMEM_REPLACEMENT=/tmp/opencode/note-rewrites/replacements/<id>.md \
  bun run slipmem -- edit <id> --json
```

`replace-note.sh` only copies the prepared file over the temporary editor
draft. The CLI then parses the draft, checks `createdAt`, `updatedAt`, unknown
keys, `legacyId`, aliases, and provenance, and calls the repository's atomic
update. IDs, `createdAt`, titles, tags, and `provenance: { source: cli, actor:
user }` were preserved. `updatedAt` advanced as designed. No core repository
write bypass was needed.

## Verification

- Body lengths after the rewrite: domain 1752, source-of-truth 1964,
  architecture 1990, service cookbook 1929, Foldkit 1945, trust boundary 1988,
  plan literature 3876, operator literature 3599. All satisfy 2000/5000.
- `bun run slipmem -- check --rebuild-index`: 8 notes, 10 files scanned,
  0 errors, 0 drift, OK. The two warnings are the expected non-note
  `.slipmem/.gitignore` and `.slipmem/README.md`.
- `tags`, `search architecture`, `search services`, `wiki architecture`, and
  `wiki coding-standards` were re-run; results are recorded in
  `docs/repository-memory-evidence.md`.
- The exact fenced TypeScript was extracted from the saved note and compiled
  with workspace `tsc` 7.0.2 and workspace `effect` 4.1.4:

  ```sh
  /home/dev/src/slipmem/node_modules/.bin/tsc \
    -p /tmp/opencode/cookbook-22815/tsconfig.json
  # exit 0
  ```

- Runtime proof resolved the service directly and through its Live layer:

  ```text
  bun /tmp/opencode/cookbook-22815/runtime.ts
  {"direct":"p:body:a","throughLayer":"p:body:b"}
  ```

- No note recommends bypassing approval or deletion. The `direct-unsafe`
  opt-in remains described as unsafe and delete-exempt only where the code
  actually enforces it.

## Residual notes

- `packages/web/src/main.ts` line numbers are current-tree pointers (`33f1ff6`
  through `576d8d0`); they differ from `1d5a7a4` by later web surface fixes.
  Function-level names (`Model`, `Message`, `update`, approve/reject cases) are
  the durable references.
- Literature references stay at `8094950` on purpose. Retargeting them to the
  live plan would silently change provenance, especially now that the plan is
  canonical `tags`.
