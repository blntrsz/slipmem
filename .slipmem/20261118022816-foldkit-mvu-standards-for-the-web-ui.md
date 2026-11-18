---
schema: 1
id: 20261118022816-foldkit-mvu-standards-for-the-web-ui
type: permanent
title: Foldkit MVU standards for the web UI
createdAt: "2026-11-18T02:28:16Z"
updatedAt: "2026-11-18T02:57:43Z"
tags:
  - coding-standards
  - foldkit
  - web
provenance:
  source: cli
  actor: user
---

The web package is one Foldkit SSR app over the JSON API. Keep MVU boundaries explicit and pure:

- `Model` is a `Schema.Struct`: `AppRoute`, `AsyncData` fields, editor state, and one request counter per async surface. `EditorState` is a tagged union (`Closed`, `Open`, `Saving`).
- `Message` uses `defineMessageUnion`. Async commands emit `Succeeded*`/`Failed*` with a request ID and typed data; user intent stays separate from completion.
- `Command.define` declares `args`, emitted messages, and an `execute` Effect. HTTP commands end with `Effect.provide(Http.layer)` and map errors to `Failed*`.
- `update` is pure: `Message.match` returns `{ model, commands }`. It may bump a counter, set `AsyncData.Loading()`, or enqueue a command; never I/O.
- Load, save, delete, search, tags, wiki, pending, and health results apply only when `message.requestId` equals the matching counter, dropping stale responses. Approve/reject deliberately skip that guard: `update` ignores their request ID, bumps `pendingRequestId`, and reloads pending; the result only triggers refresh.
- `view` is pure; handlers build `HtmlBuilder<Message>` nodes. Note text is rendered as text/Markdown data, never trusted HTML.
- Routes are `defineRouteUnion` plus parsers and href builders. Link clicks become `NavigateInternal`; `ChangedUrl` enters the route; delete has a confirmation route.
- Domain validation is shared: the editor uses `Markdown.CONTENT_LIMITS`, `slugifyTag`, and the reference rule; the server enforces the same contract.

When adding a page: add a route/href builder, model data plus request counter, messages, one load command, update cases, and a view. Keep server data in the model; order lists by newest `updatedAt`, then ID, never array position.

Tests exercise `init`, `update`, and route builders under Bun/Vite SSR.

Evidence: `packages/web/src/route.ts:12-159`, `packages/web/src/main.ts:133-218,909-1355`, `packages/web/README.md:3-60`.
