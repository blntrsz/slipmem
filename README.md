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

See [`packages/mcp/README.md`](packages/mcp/README.md) for MCP client setup.

