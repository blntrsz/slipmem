# @slipmem/web

A [Foldkit](https://foldkit.dev) application for slipmem. It lists fleeting,
literature, and permanent notes and provides create, edit, and delete forms for
each kind.

The same server entry also exposes the JSON API from `@slipmem/server` and the
streamable HTTP MCP endpoint. One process serves pages, `/api`, and `/mcp`; there
is no separate API server to start.

## Running

From the repository root:

```sh
bun run web
```

`bun run web` starts the Vite development host with server-side rendering. The
application renders the initial page on the server, hydrates in the browser, and
loads notes from the JSON API.

The scripts use `bun --bun vite` because the note services use
`@effect/sql-sqlite-bun`. Vite's development SSR runner must execute under Bun to
load the `bun:sqlite` driver.

Notes are stored in SQLite. The default database is
`$XDG_DATA_HOME/slipmem/slipmem.db`, falling back to
`~/.local/share/slipmem/slipmem.db`; set `SLIPMEM_DB_PATH` to override it. The
stdio MCP server uses the same default, so both apps see the same notes.

```sh
SLIPMEM_DB_PATH=/path/to/slipmem.db bun run web
```

## Production

```sh
bun run web:build
PORT=3000 bun run web:serve
```

The build writes the client bundle to `dist/client`, the Web `fetch` handler to
`dist/server/fetch.js`, and `dist/server/foldkit.build.json`. `web:serve` runs
that handler with `Bun.serve` and serves built client assets. `PORT` and `HOST`
select the listening address; they default to `3000` and `127.0.0.1`.

The API and MCP endpoint do not have authentication, so the server binds to
loopback by default. Set `HOST=0.0.0.0` only when you intentionally expose it
and can restrict access at the network level.

## JSON API

Example requests:

```sh
curl http://localhost:3000/api/notes
curl -X POST http://localhost:3000/api/notes/fleeting \
  -H 'content-type: application/json' \
  -d '{"title":"A thought","content":"Capture it"}'
curl -X PUT http://localhost:3000/api/notes/fleeting/<id> \
  -H 'content-type: application/json' \
  -d '{"title":"Edited","content":"Updated"}'
curl -X DELETE http://localhost:3000/api/notes/fleeting/<id>
```

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/health` | `{ "ok": true, "service": "slipmem" }` |
| `GET` | `/api/notes` | `{ "notes": [...] }` across all three kinds |
| `GET` | `/api/notes/:type` | Notes for one kind |
| `GET` | `/api/notes/:type/:id` | `{ "note": ... }`, or `null` when missing |
| `POST` | `/api/notes/:type` | Created note, status `201` |
| `PUT` | `/api/notes/:type/:id` | Updated note, status `200` |
| `DELETE` | `/api/notes/:type/:id` | `{ "deleted": true \| false }` |

`:type` is `fleeting`, `literature`, or `permanent`. List responses return
`Note.Info` values from `@slipmem/schemas/note`, so every note carries its `type`
discriminant. Literature notes also carry `reference`.

Create and update bodies require `title` and `content`; literature notes also
require `reference`. Requests must use `content-type: application/json`. The
per-kind schemas enforce the existing content limits: 1000 characters for
fleeting notes, 2000 for permanent notes, and 5000 for literature notes.

## MCP over HTTP

The streamable HTTP MCP endpoint is at `/mcp` and exposes the same fifteen CRUD
tools as the stdio server:

| Slice | Tools |
| --- | --- |
| Fleeting | `list_fleeting_notes`, `get_fleeting_note`, `create_fleeting_note`, `update_fleeting_note`, `delete_fleeting_note` |
| Permanent | `list_permanent_notes`, `get_permanent_note`, `create_permanent_note`, `update_permanent_note`, `delete_permanent_note` |
| Literature | `list_literature_notes`, `get_literature_note`, `create_literature_note`, `update_literature_note`, `delete_literature_note` |

Example MCP client configuration:

```json
{
  "mcpServers": {
    "slipmem-web": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

The tools read and write the same database as the web UI and the stdio server.

## Development

```sh
bun test packages/web packages/server
bun run typecheck
bun run web:build
```
