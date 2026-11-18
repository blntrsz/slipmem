---
schema: 1
id: 20261118022815-service-cookbook-shape-factory-and-live-layer
type: permanent
title: "Service cookbook: Shape, factory, and Live layer"
createdAt: "2026-11-18T02:28:15Z"
updatedAt: "2026-11-18T02:28:15Z"
tags:
  - coding-standards
  - effect
  - services
  - layers
provenance:
  source: cli
  actor: user
---

Core services follow one repeatable Effect v4 shape: a narrow `Shape`, a `Context.Service` tag, a pure factory for tests, and a `Live` Layer over ambient dependencies.

```ts
export interface ThingShape {
  readonly root: string
  readonly read: (id: string) => Effect.Effect<string, ThingError>
}

export class ThingService extends Context.Service<ThingService, ThingShape>()(
  "@slipmem/core/ThingService",
) {}

export const makeThingService = (
  repository: ThingRepository,
  config: ThingConfig = {},
): Effect.Effect<ThingShape, ThingError> =>
  Effect.gen(function* () {
    const now = config.now ?? Date.now
    return { root: repository.root, read }
  })

export const ThingServiceLive = (
  config: ThingConfig = {},
): Layer.Layer<ThingService, ThingError, MarkdownNoteRepository> =>
  Layer.effect(
    ThingService,
    Effect.gen(function* () {
      const repository = yield* MarkdownNoteRepository
      return yield* makeThingService(repository, config)
    }),
  )
```

Rules that keep this testable:
- Depend on a `Pick` of the repository shape the service uses. `WikiService` uses `root` and `scan`; `ApprovalService` adds `get/create/update/delete`.
- Inject time, environment, stores, and adapters through config. Production uses `Date.now`; tests use a fixed clock.
- Return typed `Data.TaggedError` values with `code`, `path`, and optional `field`; do not throw for expected failures.
- For SQLite, use `Layer.effect` plus `Effect.acquireRelease` so the handle closes with the scope.
- Compose once per note root with `Layer.provide`; expose siblings with `Layer.mergeAll`. Surface code stays an adapter.
- A derived-index refresh after a durable write is a warning, not a rollback.
Tests build `makeXService` with a temporary root, fixed clock, and injected store, assert exact error codes and real files, then add one Live-layer test. Examples: `packages/core/src/wiki/wiki-service.ts:75-88,450-459`, `packages/core/src/approval/approval-service.ts:1046-1056`.
