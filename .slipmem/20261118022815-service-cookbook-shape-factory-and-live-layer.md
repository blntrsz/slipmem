---
schema: 1
id: 20261118022815-service-cookbook-shape-factory-and-live-layer
type: permanent
title: "Service cookbook: Shape, factory, and Live layer"
createdAt: "2026-11-18T02:28:15Z"
updatedAt: "2026-11-18T02:55:30Z"
tags:
  - coding-standards
  - effect
  - services
  - layers
provenance:
  source: cli
  actor: user
---

Core services follow one Effect v4 pattern: a narrow Shape, a `Context.Service` tag, a factory that closes over its dependency and config, and a Live layer over an ambient tag.

```ts
import { Context, Data, Effect, Layer } from "effect"

export class NoteError extends Data.TaggedError("NoteError")<{
  readonly id: string
  readonly message: string
}> {}

export interface StoreShape {
  readonly read: (id: string) => Effect.Effect<string, NoteError>
}

export class Store extends Context.Service<Store, StoreShape>()(
  "@slipmem/core/Store",
) {}

export interface ReaderConfig {
  readonly prefix?: string
}

export interface ReaderShape {
  readonly read: (id: string) => Effect.Effect<string, NoteError>
}

export class Reader extends Context.Service<Reader, ReaderShape>()(
  "@slipmem/core/Reader",
) {}

export const makeReader = (
  store: StoreShape,
  config: ReaderConfig = {},
): Effect.Effect<ReaderShape, NoteError> => {
  const prefix = config.prefix ?? ""
  const read = (id: string): Effect.Effect<string, NoteError> =>
    store.read(id).pipe(Effect.map((body) => prefix + body))
  return Effect.succeed({ read })
}

export const ReaderLive = (
  config: ReaderConfig = {},
): Layer.Layer<Reader, NoteError, Store> =>
  Layer.effect(
    Reader,
    Effect.gen(function* () {
      const store = yield* Store
      return yield* makeReader(store, config)
    }),
  )
```

- Depend on the exact shape; inject time and adapters through config.
- Build `read` as a closure and return it.
- Type expected failures as `Data.TaggedError`; do not throw.
- `Live` yields the dependency tag and delegates to the factory; compose with `Layer.provide`.
- Tests call the factory with a temporary root, fixed clock, and fake store, then add one Live-layer test.

Real examples: `packages/core/src/wiki/wiki-service.ts:75-88,158-162,450-459`; repository `packages/core/src/markdown/repository.ts:159-163,517-519,797-800`.
