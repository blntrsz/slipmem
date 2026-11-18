---
schema: 1
id: 20261118022816-foldkit-mvu-standards-for-the-web-ui
type: permanent
title: Foldkit MVU standards for the web UI
createdAt: "2026-11-18T02:28:16Z"
updatedAt: "2026-11-18T02:28:16Z"
tags:
  - coding-standards
  - foldkit
  - web
provenance:
  source: cli
  actor: user
---

The web package is one Foldkit SSR app over the JSON API. Keep the MVU boundaries explicit and pure:

- `Model` is an `Effect.Schema.Struct`: `AppRoute`, `AsyncData` fields, editor state, and one request counter per async surface. `EditorState` is a tagged union (`Closed`, `Open`, `Saving`).
- `Message` is defined with `defineMessageUnion`. Every async command gets `Succeeded*` and `Failed*` messages carrying a request ID and typed data. User intent is separate from completion.
- `Command.define` declares `args`, the messages it may emit, and an `execute` Effect. HTTP commands end with `Effect.provide(Http.layer)` and map errors to `Failed*` messages.
- `update` is pure: `Message.match` returns `{ model, commands }`. It may increment a request ID, set `AsyncData.Loading()`, or enqueue a command, but performs no I/O directly.
- Apply async results only when `message.requestId` still equals the matching model counter. This discards stale responses after navigation or a newer request.
- `view` is pure and returns a `Document`; handlers build `HtmlBuilder<Message>` nodes. Note text is rendered as text/Markdown data, never trusted HTML.
- Routes are a `defineRouteUnion` plus `Route` parsers and href builders. Link clicks become `NavigateInternal`; `ChangedUrl` parses the URL and enters the route. Delete has its own confirmation route.
- Domain validation is shared. The editor uses `Markdown.CONTENT_LIMITS`, `slugifyTag`, and the literature reference rule; the server enforces the same contract.

When adding a page: add a route and href builder, model data plus request counter, messages, one load command, update cases, and a view. Keep server data in the Foldkit model. Keep list ordering explicit (newest `updatedAt`, then ID), never array position.

Tests exercise `init`, `update`, and route builders directly under the Bun/Vite SSR setup.

Evidence: `packages/web/src/route.ts:5-127`, `packages/web/src/main.ts:49-193,893-1168`, `packages/web/README.md:3-60`.
