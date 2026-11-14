# @slipmem/server

The HTTP surface for slipmem. It reuses the Effect note services and SQLite
tables from `@slipmem/core`, and it is mounted by the Foldkit server entry in
`@slipmem/web`.

`makeApiHandler(databasePath)` returns a Web `fetch` handler with two transports:

- JSON routes under `/api`
- a streamable HTTP MCP endpoint at `/mcp`

Both transports share one database layer, so they see the same notes.

## Usage

```ts
import { makeApiHandler, resolveDatabasePath } from "@slipmem/server"

const api = makeApiHandler(resolveDatabasePath())

const response = await api.handler(
  new Request("http://localhost/api/notes"),
)
```

Call `api.dispose()` when the host shuts down. The Foldkit server entry disposes
the previous handler when Vite reloads the server module, closes the current one
on `SIGINT`/`SIGTERM`, and routes `/api` and `/mcp` requests to it through
`Server.Responded`.

## Database

`resolveDatabasePath()` matches the stdio MCP server:

```text
$XDG_DATA_HOME/slipmem/slipmem.db
```

It falls back to `~/.local/share/slipmem/slipmem.db` and honors
`SLIPMEM_DB_PATH`. Startup runs the checked-in Drizzle migrations, so an
existing database is upgraded in place; databases created by the old
`CREATE TABLE IF NOT EXISTS` bootstrap are validated and adopted without
losing rows. A database whose Drizzle history does not include the bundled
initial migration is refused instead of having the initial migration appended
to unknown history. In a deployment that does not keep the repository's
`packages/server/drizzle` directory next to the running code, point
`SLIPMEM_MIGRATIONS_DIR` at a copy of it.

## JSON API

| Method | Path |
| --- | --- |
| `GET` | `/api/health` |
| `GET` | `/api/notes` |
| `GET` | `/api/notes/:type` |
| `GET` | `/api/notes/:type/:id` |
| `POST` | `/api/notes/:type` |
| `PUT` | `/api/notes/:type/:id` |
| `DELETE` | `/api/notes/:type/:id` |

`:type` is `fleeting`, `literature`, or `permanent`. Lists read through
`NoteService` so every result is a `Note.Info` tagged union. Writes use the
per-kind services because each kind has its own input schema.

Create and update bodies require `title` and `content`; literature notes also
require `reference`. Requests must use `content-type: application/json`, and the
per-kind schemas enforce the content length limits.

## MCP tools

`NoteRegistrations` is also exported from `@slipmem/server/note-tools`. The stdio
server in `@slipmem/mcp` uses the same registrations, so the two MCP transports
cannot drift apart.

## Development

```sh
bun test packages/server
bun run typecheck
```
