# slipmem

This repository is a [Bun](https://bun.sh/) monorepo. Workspace packages live
in `packages/*` and each package should have its own `package.json`.

Install dependencies from the repository root:

```sh
bun install
```

## Packages

- `packages/core` — note services and SQLite implementations
- `packages/schemas` — Effect Schema definitions for each note slice
- `packages/mcp` — stdio MCP server exposing the note services
- `packages/server` — HTTP JSON API and streamable HTTP MCP endpoint
- `packages/web` — Foldkit web application with list and CRUD UI

## Web application

The Foldkit app in `packages/web` serves the note list and CRUD editor for all
three note kinds. The same process also serves the JSON API under `/api` and the
streamable HTTP MCP endpoint at `/mcp`, so there is no separate API server to
start.

```sh
bun run web
```

The development host is Vite with server-side rendering. It reads and writes the
same SQLite database as the stdio MCP server:

```text
$XDG_DATA_HOME/slipmem/slipmem.db
```

Override it with `SLIPMEM_DB_PATH`:

```sh
SLIPMEM_DB_PATH=/path/to/slipmem.db bun run web
```

Build and serve the production bundle with:

```sh
bun run web:build
PORT=3000 bun run web:serve
```

The production server binds to `127.0.0.1` by default because the API and MCP
endpoint are unauthenticated. Set `HOST=0.0.0.0` only when you intentionally
expose it behind your own access controls.

See [`packages/web/README.md`](packages/web/README.md) for the UI routes, API
endpoints, and MCP setup. See [`packages/mcp/README.md`](packages/mcp/README.md)
for the stdio MCP client setup.

