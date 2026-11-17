# @slipmem/server

The HTTP surface for slipmem. Notes are Markdown files under the local
`.slipmem/` root; this package serves the canonical ID-based JSON API, the
on-demand cited topic wiki, the human approval queue, and the shared HTTP MCP
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
only for the migration importer and the compatibility window.

The disposable search index lives outside the note root under
`$XDG_CACHE_HOME/slipmem/index/<root-hash>/index.sqlite`. It can be deleted and
rebuilt at any time.

## JSON API

Canonical routes are ID-based. A note ID is the Markdown filename stem:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/health` | Service status, note root, index mode and count |
| `GET` | `/api/notes` | Bounded list; `type`, `topic`, `limit` filters |
| `POST` | `/api/notes` | Create with `type` in the JSON body |
| `GET` | `/api/notes/:id` | One note or 404 |
| `PUT` | `/api/notes/:id` | Partial update; human web write |
| `DELETE` | `/api/notes/:id` | Move the note to the local backup directory |
| `GET` | `/api/search` | Bounded ranked search; requires `q` |
| `GET` | `/api/topics` | Topic inventory with counts |
| `GET` | `/api/wiki/:topic` | Structured cited page; `format=markdown` for text |
| `GET` | `/api/pending` | Pending proposals with inspectable diffs |
| `POST` | `/api/pending/:proposalId/approve` | Apply a proposal |
| `POST` | `/api/pending/:proposalId/reject` | Discard a proposal |

Single-note responses are `{ "note": ... }`. Lists are `{ "notes": [...] }` or
`{ "topics": [...] }`. Errors are `{ "error": "...", "code": "..." }`.

Create and update bodies require `title` and `content`; literature notes also
require `reference`. Mutating requests require `content-type:
application/json`. The Markdown repository enforces the type content limits
(1000 / 2000 / 5000 characters), topic normalization, and the literature
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

`GET /api/wiki/:topic` defaults to structured sections with sources and
citations; `format=markdown` returns only the rendered Markdown. Generation is
read-only and bounded. Extractive mode quotes selected notes verbatim. A
configured synthesizer is opt-in via `SLIPMEM_WIKI_SYNTHESIS`; unsupported
sentences are omitted before output.

`GET /api/pending` reads proposals from `.slipmem/.state/pending/` and returns
their operation, target ID, path, actor, expiry, staleness, and a line diff.
Approve and reject are human HTTP actions: no MCP tool can call them. Approving
revalidates the base content hash and all note rules; a stale proposal is
rejected without writing.

Pending proposals never appear in the note list, search, topics, or the note
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
