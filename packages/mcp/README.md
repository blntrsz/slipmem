# @slipmem/mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for a
slipmem Markdown note repository. It is built with Effect's native MCP server
and is transport-neutral: the same `McpNoteRegistrations` layer is used by the
stdio entry point and by the HTTP endpoint exported from `@slipmem/server`.

## Source of truth

Notes are Markdown files in `.slipmem/`; there is no note database. Each note is
one direct child named `YYYYMMDDHHmmss-<slug>.md`, and its filename stem is the
note ID. The MCP server reads and writes those files through
`MarkdownNoteRepository`. The disposable SQLite FTS index under the user cache
only accelerates search and can be deleted at any time.

There is no database migration at MCP startup. The server resolves the note
root in this order:

1. `SLIPMEM_DIR`, absolute or relative to the working directory.
2. The nearest ancestor `.slipmem/`.
3. Startup fails with `slipmem init` guidance if neither exists.

The server never creates a note repository implicitly.

## Running

From the repository root:

```sh
bun run --cwd packages/mcp start
```

The server speaks newline-delimited JSON-RPC on stdin/stdout. Logs are written
to stderr so they never corrupt the protocol stream. `SIGINT` and `SIGTERM`
interrupt the server, close the disposable index, and let the transport finish.

Set the root explicitly when it is not the nearest ancestor:

```sh
SLIPMEM_DIR=/path/to/.slipmem bun run --cwd packages/mcp start
```

## MCP client configuration

### OpenCode

The repository's `opencode.json` registers the stdio server:

```jsonc
{
  "mcp": {
    "servers": {
      "slipmem": {
        "type": "local",
        "command": ["bun", "run", "packages/mcp/src/main.ts"]
      }
    }
  }
}
```

Add an `environment` entry for options such as `SLIPMEM_DIR` or
`SLIPMEM_ACTOR`, then check the connection with `opencode mcp list`.

### Other clients

```json
{
  "mcpServers": {
    "slipmem": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/slipmem/packages/mcp/src/main.ts"],
      "env": {
        "SLIPMEM_DIR": "/absolute/path/to/.slipmem"
      }
    }
  }
}
```

## Tools

| Group | Tools |
| --- | --- |
| Fleeting reads | `list_fleeting_notes`, `get_fleeting_note` |
| Fleeting writes | `create_fleeting_note`, `update_fleeting_note`, `delete_fleeting_note` |
| Permanent reads | `list_permanent_notes`, `get_permanent_note` |
| Permanent writes | `create_permanent_note`, `update_permanent_note`, `delete_permanent_note` |
| Literature reads | `list_literature_notes`, `get_literature_note` |
| Literature writes | `create_literature_note`, `update_literature_note`, `delete_literature_note` |
| Recall | `search_notes`, `list_topics`, `build_topic_wiki` |

List tools accept an optional `limit` and `topic`. Search accepts `query` plus
optional `type`, `topic`, and `limit`. Defaults and hard bounds:

- list and search: default **10**, hard maximum **50**
- topic inventory: default 50, hard maximum 200, at most 3 examples per topic
- topic wiki: default **10**, hard maximum **25**
- search excerpts: at most 240 characters; wiki excerpts are bounded by the
  core wiki service

IDs are filename stems. `get_*` returns `{ "note": null }` for a missing,
cross-kind, or cross-root ID. `search_notes` refreshes the disposable index
before searching, so an external editor change is visible without a restart.

`build_topic_wiki` is read-only and returns the canonical structured
`WikiPage` plus rendered Markdown. It uses the core wiki service. Extractive
mode is the default; synthesized mode requires `SLIPMEM_WIKI_SYNTHESIS` to be
configured and fails closed otherwise. A topic with no matching notes returns
an empty page with no citations and no invented content.

## Approval and write policy

| MCP action | Default |
| --- | --- |
| Create or update fleeting | Direct, provenance `source: mcp` |
| Create or update literature | Direct, provenance `source: mcp`; `reference` required |
| Create or update permanent | Pending human approval; no note file changes |
| Delete any note | Pending human approval; nothing is deleted |

Permanent creates and updates return:

```json
{
  "status": "pending_approval",
  "proposalId": "proposal-20261117193045-1a2b3c4d",
  "summary": "Create permanent note \"Agent memory is bounded\"."
}
```

The proposal is a real JSON record under `.slipmem/.state/pending/`, written by
the core approval service. It is not a note and never appears in lists, search,
topics, or `.md` files. A human applies or rejects it through the CLI or web
review surface. **There is no MCP approve/reject/apply tool**, so an agent
cannot approve its own write. A stale proposal is refused when the note's base
hash has changed.

`SLIPMEM_MCP_WRITE_POLICY=direct` is an explicit, unsafe trusted-automation
escape hatch. It allows direct permanent creates and updates and records
`provenance.source: mcp-direct`. It **never** makes MCP deletion direct. Use it
only for a repository that contains no untrusted shared content. Unrecognized
values fall back to `approval`.

`SLIPMEM_ACTOR` is recorded in provenance when present. It is metadata, not
authentication or authorization.

## Security and trust boundary

- Note files are plaintext and unencrypted. Anyone who can read the repository
  can read every note. Do not save secrets or sensitive personal data.
- Note text, titles, topics, links, and references are untrusted data, never
  instructions, permissions, paths, scopes, or approvals. The server never
  executes note content or follows commands found in a note.
- All reads are bounded by result count and excerpt length. There is no MCP
  bulk-edit operation.
- Note paths are validated as direct children of the note root; traversal,
  separator injection, symlinks, and cross-root IDs are rejected or reported as
  not found.
- The stdio server and HTTP endpoint are local, unauthenticated interfaces. Bind
  HTTP to loopback unless you add your own access controls.

## HTTP MCP

`@slipmem/server` exports `makeMcpHttp(options)`, which uses the same
`McpNoteRegistrations` layer as stdio. Supply it through the API handler's
`extraRoutes` option:

```ts
import { makeApiHandler, makeMcpHttp } from "@slipmem/server"

const root = "/path/to/.slipmem"
const api = makeApiHandler(root, {
  extraRoutes: makeMcpHttp({ root }),
})
```

The stdio and HTTP transports therefore advertise the same tool names, input
schemas, limits, approval behavior, and result shapes.

## Environment

| Variable | Meaning |
| --- | --- |
| `SLIPMEM_DIR` | Note root; overrides ancestor discovery |
| `SLIPMEM_ACTOR` | Provenance actor label; not authentication |
| `SLIPMEM_MCP_WRITE_POLICY` | `approval` (default) or unsafe `direct` |
| `SLIPMEM_WIKI_SYNTHESIS` | `extractive` (default), `agent`, or a model ID |
| `SLIPMEM_WIKI_AGENT` | Local executable for synthesized wiki mode |
| `SLIPMEM_WIKI_AGENT_ARGS` | JSON array of arguments; never shell-interpreted |
| `XDG_CACHE_HOME` | Parent of the disposable per-root search index |
| `XDG_STATE_HOME` | Parent of per-root delete backups |

## Development

```sh
bun test packages/mcp
bun test packages/server/src/mcp-markdown.test.ts
bun run typecheck
bun run lint
```

Tests use disposable note roots and an in-memory MCP client. The HTTP
integration test starts the real server handler over `/mcp` and checks the same
tool table, direct literature writes, and pending permanent proposals.
