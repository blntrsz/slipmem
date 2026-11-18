# Approval index-refresh evidence

Date: 2026-11-18
Plan gap: `docs/mvp-plan.md` §8.2 step 6 ("It then refreshes the index and
removes the proposal").

## Gap

A successful human approval wrote (or deleted) the Markdown note and removed the
proposal, but did not refresh the disposable search index. Running `slipmem
check` immediately after `slipmem approve` therefore reported `index-missing` /
`index-stale` (or `index-extra` after an approved delete) until an unrelated
`search`, `topics`, health request, or `check --rebuild-index`.

## Contract

- The Markdown note remains the only source of truth. The index is disposable
  derived data.
- `ApprovalServiceConfig` accepts an optional
  `refreshIndex: () => Effect<void, MarkdownError>` dependency. The core service
  calls it only after the repository has durably applied a create, update,
  reclassify, or delete.
- A cache failure never rolls back, hides, or re-proposes a durable note change.
  The proposal is still removed and `apply` still returns `status: "applied"`.
- Each applied result carries:
  - `index.status`: `refreshed`, `failed`, or `skipped` (no dependency wired,
    used by non-approval callers).
  - `index.warning` when `failed`: names the cache error and the recovery path,
    `slipmem check --rebuild-index`.
- The existing repository under-lock compare-and-swap is unchanged:
  `expectedContentHash` is still passed for approved updates and deletes, and
  the proposal store lifecycle (put/get/revalidate/remove) is untouched.

## Wiring

- `packages/core/src/approval/approval-service.ts` owns the post-apply refresh
  and the fail-open warning, so CLI and server do not duplicate logic.
- `packages/cli/src/approval-access.ts` optionally supplies a refresh callback
  that opens the normal CLI index configuration. Only `approve` enables it;
  `review` and `reject` do not depend on the cache.
- `packages/server/src/markdown.ts` provides the same shared index instance to
  the approval layer that the API reads, via the search-index service.
- `packages/server/src/api.ts` and `packages/cli/src/commands/approve.ts` expose
  the `index` result. JSON clients see it directly; human CLI output prints the
  recovery warning on stderr only when refresh failed.

## Regression coverage

All tests run without an intervening `search`/`topics` request between approval
and checking drift.

1. `packages/core/src/approval/approval.test.ts`
   - "refreshes the derived index after each durable approval": create, update,
     and delete each call the refresh dependency once.
   - "keeps a durable note and warns when the index cache cannot refresh": apply
     succeeds, the note remains listable, the proposal is removed, and the
     warning includes the cache error and recovery command.
2. `packages/cli/src/approval.test.ts`
   - "approval refreshes the derived index before check without a search":
     actual CLI `approve` for create, update, and delete, then actual CLI
     `check --json` reports `report.index.drift === 0` with no
     `index-missing`, `index-stale`, or `index-extra` warning.
   - "keeps an approved note and warns when the index cache is unavailable":
     `XDG_CACHE_HOME` points at a regular file; `approve` exits 0, returns
     `index.status: "failed"` with `check --rebuild-index` guidance, and `show`
     still reads the approved note.
3. `packages/server/src/app.test.ts`
   - "HTTP approval refreshes the derived index before the next check": HTTP
     `POST /api/pending/<id>/approve` for create, update, and delete, followed by
     a direct index snapshot plus `checkNoteRoot` with `drift === 0` and no
     index warnings.

Commands run:

```sh
bun run lint
bun run typecheck
bun test
bun test packages/core/src/approval/approval.test.ts \
  packages/cli/src/approval.test.ts \
  packages/server/src/app.test.ts
bun test packages/cli/src/approval.test.ts
bun run web:build
```

The full suite passed: 383 tests across 45 files, 0 failures.

## Recording impact

The product-tour recording remains behaviorally accurate. In the normal
(non-failing) path the only visible difference is an additional `index` object
in `approve --json` and HTTP approval responses; human output is unchanged
unless the cache refresh fails. No scene needs to be re-recorded for this fix.
