# Serving runtime extraction

Status: shared graph, provider, watcher, receipts, worker, lifecycle, and lease
implemented in `@slipmem/core/runtime`, 2026-11-23. This note is a context
pointer for remaining entry-point/barrel coordination; the code and tests are
authoritative.

## Goal

Every serving surface for one note root uses **one scoped service graph**:

- JSON API (`/api`)
- HTTP MCP (`/mcp`)
- stdio MCP (`packages/mcp/src/main.ts`)
- `slipmem service`
- the web entry

The graph builds one repository, one resilient disposable index, one approval
proposal store, one wiki service, one prompt-recall service, and (when automatic
memory is enabled) one raw-write signal, one maintenance worker, and one
lifecycle.

Consolidation is serialized across processes by **one reusable run lease**, not
a serving-only copy plus a separate CLI copy.

## Ownership

`@slipmem/core/runtime` owns all shared serving behavior:

- `automatic-memory.ts`: primary chat model and automatic-memory provider
  resolution, recall provider resolution, startup notices, raw-write queue and
  repository wrapper, note-root watcher, durable revision receipts, the
  maintenance worker layer, and the event-driven lifecycle.
- `serving.ts`: one repository, one raw-write signal, one resilient index, the
  human approval/wiki/recall services, the worker, and the lifecycle.
- `run-lease.ts`: the cross-process lease used by serving and CLI
  `--consolidate`.

`@slipmem/mcp` owns only MCP-specific registration behavior:

- `McpApprovalService` (`submitMcp` projection only);
- `McpNoteRegistrations`;
- a thin `makeServingRuntime` that adds the approval projection over the core
  graph.

`packages/mcp/src/automatic-memory.ts` is a compatibility re-export. It no
longer owns provider resolution, watching, receipts, or lifecycle construction.

## Graph

```
MarkdownNoteRepositoryLive(root)
        │
        ├── makeRawWriteSignalLayer() ──► RawWriteSignal
        │
        └── makeRawWriteRepositoryLayer()
                    │  (wrapped repository + RawWriteSignal)
                    ▼
        makeServingServicesLayer()                 [@slipmem/core/runtime]
          ├── MarkdownSearchIndexResilientFromRepository
          ├── ApprovalServiceLive (human; refreshes the index)
          ├── WikiServiceLive
          └── PromptRecallServiceLive
                    │
                    ▼
        makeMaintenanceLayer()                     [@slipmem/core/runtime]
          ├── PermanentMaintenanceWorkerLive
          └── makeAutomaticMemoryLayer (queue + watcher + receipts + lease)
                    │
                    ▼
        McpApprovalServiceLive                     [@slipmem/mcp]
                    │
                    ▼
        McpNoteRegistrations
```

`makeServingRuntime` in `@slipmem/core/runtime` returns `{ automaticMemory,
services }`. `@slipmem/mcp` adds only the approval projection and registrations.

`packages/server/src/serving-runtime.ts` exports:

- `makeServingAppLayer(noteRoot, options)`: merges `MarkdownApiRoutes` with the
  HTTP MCP route over `runtime.services`;
- `makeServingApiHandler(noteRoot, options)`: the same Web `fetch` handler,
  readiness, and disposal contract as `makeApiHandler`.

## Reusable run lease

`packages/core/src/runtime/run-lease.ts` is the single implementation:

- `withRunLease` for the serving lifecycle (waits, recovers a dead/aged owner);
- `tryAcquireRunLeaseSync` for the CLI `--consolidate` path (rejects a live
  owner instead of queueing);
- `inspectRunLease` for status checks;
- `RUN_LEASE_FILENAME`, `runLeasePath`, and the stale/poll defaults.

It writes through `ensureStateDirectory`, so a symlinked `.state/` is rejected
at the audited core boundary. `packages/mcp/src/automatic-memory.ts` re-exports
the lease symbols for compatibility, and
`packages/cli/src/capture/checkpoint.ts` uses the same implementation for
`--consolidate`.

## Integration status

- `packages/mcp/src/layer.ts`: `makeMcpRegistrationsLayer` delegates to the
  shared runtime. `makeMarkdownServicesLayer` and
  `makeMcpSharedRegistrationsLayer` remain compatibility wrappers; the latter
  uses the core `makeMaintenanceLayer` and the resilient index.
- `packages/service/src/server.ts`: uses `makeServingApiHandler` directly.
- `packages/web/src/entry.server.ts`: uses `makeServingApiHandler`; the Git
  ingress is passed as `extraRoutes`, and `/mcp` is mounted by the shared graph.
- `packages/server/src/app.ts` and `packages/server/src/markdown.ts`: unchanged by
  this extraction. `makeApiHandler` still uses the legacy
  `makeMarkdownLayer` + `makeMcpHttp` composition for API-only callers and
  tests. `makeMarkdownLayer` now uses the resilient index, so the legacy path
  also degrades a damaged cache safely. Production service/web no longer use
  that path. The remaining collapse is to switch `makeAppLayer` to
  `makeServingAppLayer` once the API-only test surface is updated.
- `packages/server/src/index.ts` and `packages/core/src/index.ts`: unchanged
  (owned by the canonical model agent). New subpaths are exported from
  `packages/*/package.json` instead:
  - `@slipmem/core/runtime`
  - `@slipmem/mcp/runtime`
  - `@slipmem/server/serving-runtime`

## Remaining gaps

- `packages/server/src/app.ts` still exposes the legacy `makeApiHandler` path
  over `makeMarkdownLayer` (API-only, or with caller-supplied `extraRoutes`).
  It is not the production service/web graph, but it remains the public API for
  existing tests and embedding hosts.
- `packages/mcp/src/layer.ts` retains `makeMarkdownServicesLayer` and
  `makeMcpSharedRegistrationsLayer` for compatibility. Both are thin wrappers
  over core services; `makeMcpSharedRegistrationsLayer` also uses the core
  maintenance layer. They still build an MCP-facing service composition over a
  host repository.
- `packages/server/src/index.ts` does not re-export the new serving-runtime
  helpers; consumers use the `@slipmem/server/serving-runtime` subpath until the
  barrel owner adds them. It still re-exports memory-runtime symbols from
  `@slipmem/mcp`; those are compatibility re-exports of core runtime.
- `packages/core/src/index.ts` does not re-export `@slipmem/core/runtime`
  symbols; consumers use the subpath.
- `packages/server/src/git-ingress.ts` still imports `PRIMARY_CHAT_ENV_NAMES`
  from `@slipmem/mcp`. It is a re-export, not behavior ownership; it can move to
  `@slipmem/core/runtime` in a later cleanup.

## Verification

The extraction is covered by:

- `packages/core/src/runtime/run-lease.test.ts`: lease serialization, dead-owner
  recovery, symlinked-state rejection, malformed-lease age-out.
- `packages/core/src/runtime/serving.test.ts`: core runtime owns provider,
  watcher, receipts, worker, and lifecycle; a raw write wakes the core worker.
- `packages/mcp/src/runtime.test.ts`: MCP adds only the approval projection over
  the shared graph; one repository and resilient index are shared.
- `packages/server/src/serving-runtime.test.ts`: JSON API and HTTP MCP observe
  the same repository in both write directions.

```sh
bunx tsc --noEmit
bunx tsc --noEmit -p packages/web/tsconfig.json
bun test packages/core/src/runtime
bun test packages/mcp/src/runtime.test.ts
bun test packages/mcp/src/tools.test.ts
bun test packages/mcp/src/automatic-memory.test.ts
bun test packages/server/src/serving-runtime.test.ts
bun test packages/service/src
bun test packages/web/src
bun test packages/cli/src/capture/capture.test.ts
bun run web:build
```
