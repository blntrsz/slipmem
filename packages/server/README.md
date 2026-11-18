# @slipmem/server

The HTTP surface for slipmem. Notes are Markdown files under the local
`.slipmem/` root; this package serves the canonical ID-based JSON API, the
on-demand cited tag wiki, the human approval queue, and the shared HTTP MCP
endpoint. The Foldkit server entry in `@slipmem/web` mounts it in the same
process as the pages.

`makeApiHandler(noteRoot)` returns a Web `fetch` handler. Pass
`extraRoutes: makeMcpHttp({ root })` to serve `/mcp` beside `/api`; the web entry
does this with the same registrations as the stdio server.

## Usage

```ts
import { makeApiHandler, makeMcpHttp, resolveNoteRootPath } from "@slipmem/server"

const root = resolveNoteRootPath()
const api = makeApiHandler(root, { extraRoutes: makeMcpHttp({ root }) })

const response = await api.handler(
  new Request("http://127.0.0.1:3000/api/notes"),
)
```

Call `api.dispose()` when the host shuts down. The Foldkit server entry disposes
the previous handler when Vite reloads the server module, closes the current one
on `SIGINT`/`SIGTERM`, and routes `/api` and `/mcp` requests to it through
`Server.Responded`.

## Note root

`resolveNoteRootPath()` uses the frozen root order:

1. `SLIPMEM_DIR`, absolute or relative to the working directory.
2. The nearest ancestor `.slipmem/`.
3. Never an implicit creation or SQLite fallback.

A missing root fails startup with a message to run `slipmem init`. There is no
SQLite note database in the HTTP startup path. `resolveDatabasePath()` remains
only for the deprecation path: `SLIPMEM_DB_PATH` names the legacy SQLite file
for the migration importer and the compatibility window, never the live note
store. Older SQLite-first documentation is superseded.

The disposable search index lives outside the note root under
`$XDG_CACHE_HOME/slipmem/index/<root-hash>/index.sqlite`. It can be deleted and
rebuilt at any time.

## JSON API

Canonical routes are ID-based. A note ID is the Markdown filename stem:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/health` | Service status, refreshed index mode/count, wiki synthesis capability |
| `GET` | `/api/notes` | Bounded list; `type`, `tag`, `limit` filters |
| `POST` | `/api/notes` | Create with `type` in the JSON body |
| `GET` | `/api/notes/:id` | One note or 404 |
| `PUT` | `/api/notes/:id` | Partial update; human web write |
| `DELETE` | `/api/notes/:id` | Move the note to the local backup directory |
| `GET` | `/api/search` | Bounded ranked search; requires `q` |
| `GET` | `/api/tags` | Tag inventory with all-type counts and a per-type breakdown |
| `GET` | `/api/wiki/:tag` | Structured cited page with synthesis capability; `format=markdown` for text |
| `GET` | `/api/pending` | Pending proposals with inspectable diffs |
| `POST` | `/api/pending/:proposalId/approve` | Apply a proposal |
| `POST` | `/api/pending/:proposalId/reject` | Discard a proposal |

Single-note responses are `{ "note": ... }`. Lists are `{ "notes": [...] }` or
`{ "tags": [...] }`. Errors are `{ "error": "...", "code": "..." }`.

Create and update bodies require `title` and `content`; literature notes also
require `reference`. Mutating requests require `content-type:
application/json`. The Markdown repository enforces the type content limits
(1000 / 2000 / 5000 characters), tag normalization, and the literature
reference rule, so the API, CLI, and MCP cannot drift.

List, search, and wiki results are bounded on the server. Defaults are 10 for
search and wiki and 10 for lists, with hard maxima of 50 for list/search and 25
for wiki. A caller cannot request the entire repository by omitting a limit.

### Compatibility adapters

These routes are kept as thin adapters for one release. They resolve through the
same ID repository and never create type folders or a second store:

| Method | Path |
| --- | --- |
| `GET` | `/api/notes/:type` |
| `GET` | `/api/notes/:type/:id` |
| `POST` | `/api/notes/:type` |
| `PUT` | `/api/notes/:type/:id` |
| `DELETE` | `/api/notes/:type/:id` |

`:type` must be `fleeting`, `literature`, or `permanent`. A type mismatch returns
404 rather than mutating the note through the wrong route.

## Wiki and review

`GET /api/wiki/:tag` defaults to structured sections with sources and
citations; `format=markdown` returns only the rendered Markdown. Generation is
read-only and bounded. Extractive mode quotes selected notes verbatim and is
the guaranteed fallback. Synthesized mode is opt-in and requires an explicitly
configured local agent (or a registered model adapter); it is not a general
tool-less process. A configured agent is normally run through a probed OS
sandbox, and `SLIPMEM_WIKI_AGENT_UNSAFE=1` is an explicit unsafe override that
runs it with the slipmem user's full filesystem privileges. The response and
`/api/health` include `wiki.synthesis` so clients can avoid offering a mode the
server cannot resolve. `includeFleeting=true` opts fleeting notes into the
citation set; permanent and literature notes are the default.

`GET /api/tags` counts every note type and also returns `byType` so clients
can explain why a tag page cites fewer notes than the count. Tag pages are
derived; `GET /api/health` refreshes the disposable index before reporting its
count.

`GET /api/pending` reads proposals from `.slipmem/.state/pending/` and returns
their operation, target ID, path, actor, expiry, staleness, and a line diff.
Approve and reject are human HTTP actions: no MCP tool can call them. Approving
revalidates the base content hash and all note rules; a stale proposal is
rejected without writing.

This is a local approval policy, not authentication and not an OS sandbox. Any
process that can reach the unauthenticated loopback port can read and write
notes directly. The loopback bind and filesystem permissions are the boundary.

Pending proposals never appear in the note list, search, tags, or the note
root.

## Network posture

The API and `/mcp` are unauthenticated. The web server binds to `127.0.0.1` by
default. Setting `HOST` is explicit; a non-loopback bind prints a warning to
stderr because anyone who can reach the address can read and write plaintext
notes.

Mutations are same-origin only: a present `Origin` must match the request Host,
`sec-fetch-site: cross-site` is refused, and no CORS response headers are ever
emitted. Command-line clients may omit `Origin`.

## Development

```sh
bun test packages/server
bun run typecheck
```
