# Phase 4 web and HTTP API evidence

Status: **implemented on `main`; verification recorded below.**
Date: 2026-11-17
Scope: `packages/server/**` and `packages/web/**`, excluding MCP-specific
registration files owned by the MCP worker. This is an evidence note, not the
shared implementation log. The plan remains
[`docs/mvp-plan.md`](./mvp-plan.md); the shared cross-phase record remains
[`docs/mvp-implementation-log.md`](./mvp-implementation-log.md).

## 1. What changed

### Canonical ID-based API

`packages/server/src/api.ts` now serves the Markdown repository directly. A note
ID is the Markdown filename stem; no route depends on array position or a
SQLite note row.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, service, noteRoot, index: { mode, path, noteCount }, wiki: { synthesis } }`; refreshes the index first |
| `GET` | `/api/notes` | Bounded list; `type`, `topic`, `limit` |
| `POST` | `/api/notes` | Create with `type` in the JSON body |
| `GET` | `/api/notes/:id` | One note or 404 |
| `PUT` | `/api/notes/:id` | Partial update, validated by the repository |
| `DELETE` | `/api/notes/:id` | Move the file to the local backup directory |
| `GET` | `/api/search` | Ranked search; requires non-empty `q` |
| `GET` | `/api/topics` | Topic inventory with all-type counts and `byType` breakdown |
| `GET` | `/api/wiki/:topic` | Structured cited page with synthesis capability; `includeFleeting=true`; `format=markdown` for Markdown |
| `GET` | `/api/pending` | Pending proposals with summaries and line diffs |
| `POST` | `/api/pending/:proposalId/approve` | Human apply; revalidates base hash and rules |
| `POST` | `/api/pending/:proposalId/reject` | Human reject; changes no note |

Compatibility adapters remain for one release:
`GET /api/notes/:type`, `GET /api/notes/:type/:id`, `POST /api/notes/:type`,
`PUT /api/notes/:type/:id`, and `DELETE /api/notes/:type/:id`. They resolve
through the same ID repository. A note fetched through the wrong type route
returns 404, and adapters never create type folders.

The API reads notes through `MarkdownNoteRepository` on every list/detail
request, so external editor and CLI changes are visible without a restart.
Search, topics, and health refresh the disposable index before reading it.

### Markdown-only startup

`packages/server/src/markdown.ts` builds the repository, disposable search
index, approval service, and wiki service over one note root.
`makeAppLayer`/`makeApiHandler` no longer construct SQLite note services or run
Drizzle note migrations. `resolveNoteRootPath()` follows `SLIPMEM_DIR`, then the
nearest ancestor `.slipmem/`, and fails with `slipmem init` guidance if the root
is missing.

`resolveDatabasePath()` and the old database layer remain exported only for the
migration importer and the compatibility window; the HTTP startup path does not
use them.

The web entry mounts the shared HTTP MCP endpoint through
`makeApiHandler(root, { extraRoutes: makeMcpHttp({ root }) })`. The MCP
registration itself is owned by the MCP worker and is not reimplemented here.

### Foldkit routes and views

`packages/web/src/route.ts` defines the route union and URL builders:

| Route | View |
| --- | --- |
| `/` | Bounded list with `type`/`topic` filters |
| `/notes/:id` | Detail: title, type, timestamps, topics, path, hash, full text |
| `/new?type=...` | Create form with type selected by route |
| `/notes/:id/edit` | Edit form for title, content, reference, topics |
| `/notes/:id/delete` | Explicit confirmation before the backup move |
| `/search?q=...` | Ranked results with ID, path, excerpt, score |
| `/topics` | Topic counts and links to topic pages |
| `/wiki/:topic?mode=...` | Structured cited sections, sources, Markdown |
| `/review` | Pending proposals with line diff and approve/reject |
| `/health` | Note root, index mode/path/count, security posture |

`packages/web/src/entry.ts` enables Foldkit routing and hydration.
`packages/web/src/entry.server.ts` renders the route shell through
`Server.renderToString({ routing: {}, init, view }, { url })` and routes `/api`
and `/mcp` to the same handler.

`packages/web/src/api.ts` decodes every response with Effect Schema, including
`ApiNote` (note union plus topics, path, content hash, provenance), search hits,
topics, health, wiki pages, and pending proposals.

## 2. Security decisions

- **Mutations are same-origin only.** `POST`, `PUT`, and delete/approve/reject
  compare a present `Origin` to the request Host, reject
  `sec-fetch-site: cross-site`, and never emit `Access-Control-Allow-Origin`.
  Command-line clients may omit `Origin`.
- **JSON only for writes.** Create/update require
  `application/json`; `text/plain` and form-style bodies are refused. A declared
  body over the bound is refused with 413.
- **Untrusted text stays text.** Note titles, bodies, references, topics, diff
  lines, and wiki Markdown are rendered as Foldkit text nodes. No
  `innerHTML`/trusted-HTML escape hatch is used. Scene tests assert that a note
  containing `<script>` produces no `script` element.
- **Bounded recall.** List/search default to 10 and hard-cap at 50; wiki
  defaults to 10 and hard-caps at 25. The API rejects non-integer or
  non-positive `limit`, missing/oversized search queries, invalid topic slugs,
  invalid IDs, and type/topic mismatches.
- **Path safety.** IDs are parsed with the frozen filename-stem pattern before
  reaching the repository, which independently rejects traversal, absolute
  paths, symlinks, and files over 1 MiB.
- **Approval is human-only, and it is a local policy gate.** The
  review/approve/reject routes are HTTP-only; they are not mounted as MCP tools.
  Pending proposals live under `.slipmem/.state/pending/` and never appear in
  note lists or the note root. Stale or expired proposals cannot be approved.
  This is not authentication and not an OS sandbox: anyone who can reach the
  unauthenticated loopback port, or edit the files as the same user, can bypass
  it. The loopback bind and filesystem permissions are the real boundary.
- **Loopback by default.** `resolveBindConfig()` defaults to `127.0.0.1:3000`.
  A non-loopback `HOST` prints an explicit warning to stderr in both the
  production serve script and the Vite development host.

## 3. Verification

Focused gates:

```sh
bun test packages/server/src/app.test.ts packages/server/src/config.test.ts
# 14 pass, 0 fail, 100 assertions

bun test packages/server/src/app.test.ts \
  packages/server/src/config.test.ts \
  packages/web/src/main.test.ts \
  packages/web/src/route.test.ts
# 44 pass, 0 fail, 203 assertions
```

The server acceptance tests cover:

- health reporting the real note root and index mode;
- canonical CRUD with direct-child flat Markdown files and backup-on-delete;
- persistence across handler restarts;
- type-route adapters, including a wrong-type 404;
- invalid type, missing title, missing literature reference, over-limit
  content, traversal-shaped ID, invalid limit, and empty search rejection;
- search/topic refresh and type filtering;
- same-origin/same-site and JSON enforcement, with no CORS header;
- an external repository write becoming visible without restart;
- cited structured and Markdown wiki output with no new note files;
- pending proposal diff, approve, reject, visibility through detail/search, and
  cross-origin approval refusal.

The web tests cover:

- `init` entering every route and issuing the expected bounded command;
- route parsing and href round-trips for every page;
- editor validation for title, type limits, literature reference, and topics;
- the new-note type selector and field labels;
- save request identity, saving state, list upsert, and navigation;
- delete confirmation command identity and list removal;
- Scene rendering for list escaping, detail by ID, delete confirmation, search,
  topics, wiki citations, review diff controls, and health;
- server-side route-shell rendering before browser commands run.

At the time of the Phase 4 slice, the full repository gate (`bun run check`)
ran lint, root and web typecheck, the complete `bun test` suite, and both Vite
bundles. Final handoff run:

```text
bun run lint          pass
bun run typecheck     pass (root and packages/web)
bun test              292 pass, 0 fail, 2030 assertions, 34 files
bun run web:build     pass (client and SSR bundles)
```

The Phase 4-only subset was **44 pass, 0 fail, 203 assertions, 6 files** for
`packages/server` and `packages/web`.

### Live production-bundle smoke test

After `bun run web:build`, the built server was started with
`SLIPMEM_DIR=/tmp/...`, `XDG_CACHE_HOME`, and `PORT=31337`:

- `GET /api/health` reported the real note root and `fts5` index mode;
- a permanent note created through `POST /api/notes` appeared on disk as one
  direct child `.md` file and in `/api/search` and `/api/topics`;
- `/api/wiki/agent-memory` returned cited structured JSON;
- `/`, `/review`, and `/api/pending` returned 200;
- an MCP `create_permanent_note` over `/mcp` returned `pending_approval`,
  `/api/pending` exposed the full diff, and `POST .../approve` wrote the note;
- `/api/notes?type=permanent` then listed both the direct web note and the
  approved MCP note;
- `HOST=0.0.0.0` printed the non-loopback warning before binding.

## 4. Acceptance mapping

| Criterion | Evidence |
| --- | --- |
| SURFACE-01/03 | One handler serves pages, `/api`, and `/mcp`; list/search/topics scan Markdown for all three types; external-write test |
| SURFACE-04 | Every note route uses the filename-stem ID; tests assert no type folders |
| SURFACE-05 | Compatibility adapters resolve the same repository and never write a second layout |
| SEC-01/02 | ID parsing, repository path checks, body/query limits, invalid-limit tests |
| SEC-03 | `resolveBindConfig`, non-loopback warning, serve/Vite tests |
| SEC-04 | Text-node rendering; Scene assertion that `<script>` produces no element |
| APPROVE-04..06, 09 | Pending API test: diff, approve, reject, stale metadata, note visibility, no proposals in list |
| WIKI-01..06 | Structured and Markdown wiki test: bounds, citations, empty topic, no persisted page |
| WIKI-07 | Consumes core `WikiService`; synthesized mode is opt-in via `SLIPMEM_WIKI_SYNTHESIS` and drops unsupported sentences |

## 5. Dependencies and follow-ups

- **Core services consumed, not duplicated:** `MarkdownNoteRepository`,
  `MarkdownSearchIndex`, `WikiService`, `ApprovalService`, and their layers.
  If the core API changes, update `packages/server/src/markdown.ts` and the
  response adapters here.
- **MCP ownership:** `packages/server/src/mcp.ts`, `packages/mcp/**`, and MCP
  tool registration remain with the MCP worker. The web entry only mounts
  `makeMcpHttp`.
- **CLI and migration ownership:** `packages/cli/**` and the SQLite importer
  are separate workers. The server retains `resolveDatabasePath` and
  `makeDatabaseLayer` exports for them; neither is in the web startup path.
- **Root files:** `README.md` was updated for the Markdown source of truth and
  the Phase 4 loop. Root `package.json` was not modified.
- **Synthesis configuration:** synthesized wiki mode requires an explicitly
  configured local agent or a registered model adapter. The API and Health page
  report `wiki.synthesis` so the browser does not offer an unavailable mode;
  a failed synthesized request keeps an extractive fallback link. Extractive
  mode remains the guaranteed cited fallback. Agent execution is restricted by
  the core sandbox probe; `SLIPMEM_WIKI_AGENT_UNSAFE=1` is an explicit unsafe
  override, not the default. It is not an arbitrary tool-less process.
- **SSR scope:** the server renders the route shell; page data is fetched by
  browser commands after hydration. The model never treats browser state as the
  source of truth.

## 6. Browser acceptance follow-up (2026-11-18)

The independent browser run recorded 25/25 normal checks and 2/2 supplemental
XSS checks, with four low/trivial UX findings. This follow-up fixes them without
changing the storage contract:

| Finding | Change | Verification |
| --- | --- | --- |
| Topic counts include fleeting, topic pages exclude them | `/api/topics` returns `byType`; the topics page shows the breakdown and explains the default citation scope; topic pages carry an `includeFleeting` link and an empty-state browse link | API test asserts the breakdown and `includeFleeting=true` selection; web Scene test asserts the explanation and link |
| Health index count lags external writes | `GET /api/health` refreshes the disposable index before reading `status()`; the label says the count was refreshed for the request | API test creates an external note after a health request and expects the next health count to include it; live smoke observed 0 -> 2 |
| Duplicate `slipmem slipmem is ready` | The health heading renders `${service} is ready` without a hard-coded prefix | Web Scene test asserts `slipmem is ready` and the absence of the duplicated prefix |
| Unavailable synthesized mode was advertised, then returned 501 | The API health and wiki responses expose `wiki.synthesis`; the UI only offers "Try synthesized" when the resolver reports it configured, explains the default otherwise, and a failed wiki request keeps a "Use extractive page" link | Web Scene tests cover both configured states and the failure fallback; API test asserts the capability field |

The synthesized capability is derived from the same
`resolveSynthesisSelection` call used by `WikiService`. It describes a
configured agent as configured, not guaranteed: the core service still fails
closed without a working OS sandbox unless `SLIPMEM_WIKI_AGENT_UNSAFE=1` is set.
It reports model IDs without a registered adapter as unavailable rather than
advertising them.

### Post-fix gates

```text
bun run lint          pass
bun run typecheck     pass (root and packages/web)
bun test              341 pass, 0 fail, 2859 assertions, 40 files
bun run web:build     pass (client and SSR bundles)
```

A production-bundle smoke run over an isolated root confirmed:

- `GET /api/health` reported `noteCount` 0, then 2 immediately after two CLI
  writes, with `wiki.synthesis` present and unconfigured;
- `GET /api/topics` reported `security` with
  `byType: { fleeting: 1, literature: 0, permanent: 0 }`;
- `/api/wiki/security` cited 0 notes and included the extractive sentence
  suggestions in Markdown, while `?includeFleeting=true` cited the fleeting
  note;
- no browser-level behavior changed in this pass; the UI assertions are Scene
  tests against the real view plus the API smoke above.

The historical SQLite-first docs remain superseded: `SLIPMEM_DB_PATH` names
only the legacy file for `migrate sqlite` and the compatibility window, never
the runtime note store.

