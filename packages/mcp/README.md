# @slipmem/mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for
slipmem notes. It is built with Effect's native MCP server
(`McpServer.layerStdio`) and reuses the note services from `@slipmem/core`.

## Running

From the repository root:

```sh
bun run --cwd packages/mcp start
```

The server speaks newline-delimited JSON-RPC on stdin/stdout. Logs are written to
stderr so they never corrupt the protocol stream.

Notes are stored in SQLite. The default database is
`$XDG_DATA_HOME/slipmem/slipmem.db`, falling back to
`~/.local/share/slipmem/slipmem.db`; set `SLIPMEM_DB_PATH` to override it:

```sh
SLIPMEM_DB_PATH=/path/to/slipmem.db bun run --cwd packages/mcp start
```

The database file and its parent directory are created automatically, and the
three note tables are created on startup with `CREATE TABLE IF NOT EXISTS`, so
pointing the server at a new file is enough.

## MCP client configuration

Use an absolute path to this repository in your MCP client configuration:

```json
{
  "mcpServers": {
    "slipmem": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/slipmem/packages/mcp/src/main.ts"],
      "env": {
        "SLIPMEM_DB_PATH": "/absolute/path/to/slipmem.db"
      }
    }
  }
}
```

## Tools

Each note slice has the same CRUD surface:

| Slice | Tools |
| --- | --- |
| Fleeting | `list_fleeting_notes`, `get_fleeting_note`, `create_fleeting_note`, `update_fleeting_note`, `delete_fleeting_note` |
| Permanent | `list_permanent_notes`, `get_permanent_note`, `create_permanent_note`, `update_permanent_note`, `delete_permanent_note` |
| Literature | `list_literature_notes`, `get_literature_note`, `create_literature_note`, `update_literature_note`, `delete_literature_note` |

Tool inputs are the operation schemas from `@slipmem/schemas`, so the same
content limits apply (1000 characters for fleeting notes, 2000 for permanent
notes, and 5000 for literature notes). Literature notes also require a
`reference`.

Successful results are returned as MCP structured content:

- list tools return `{ "notes": [...] }`
- get tools return `{ "note": ... }`, with `null` when the note does not exist
- delete tools return `{ "deleted": true | false }`
- create and update tools return the note object

Updating a note that does not exist is reported as a tool error with
`isError: true`.

## Development

```sh
bun test packages/mcp
bun run typecheck
```
