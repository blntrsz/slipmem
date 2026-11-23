# @slipmem/mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for a
slipmem Markdown note repository. It is built with Effect's native MCP server
and is transport-neutral: the same `McpNoteRegistrations` layer is used by the
stdio entry point and by the HTTP endpoint exported from `@slipmem/server`.

## Source of truth

Notes are Markdown files in `.slipmem/`; there is no note database. Each new
note is one direct child named `<kebab-slug>.md`, and its filename stem is the
note ID. Legacy `YYYYMMDDHHmmss-<slug>.md` names remain readable and writable.
The MCP server reads and writes those files through `MarkdownNoteRepository`.
The disposable SQLite FTS index under the user cache only accelerates search and
can be deleted at any time.

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

### OpenCode shared service (remote)

To run one long-lived service per canonical root instead of starting stdio per
client, start it once and register its loopback endpoint:

```sh
bun run slipmem -- service start --port 4319
bun run slipmem -- service status --json
bun run slipmem -- service stop
```

```jsonc
{
  "mcp": {
    "servers": {
      "slipmem": {
        "type": "remote",
        "url": "http://127.0.0.1:4319/mcp",
        "oauth": false
      }
    }
  }
}
```

OpenCode enables OAuth for remote servers by default. This endpoint offers no
OAuth, so set `oauth: false` (supported by OpenCode) and rely on the loopback
bind and file permissions instead. This is an explicit client mode: the default
stdio entry remains standalone and is not attached to a background URL. There is
one service (one consolidation consumer) per canonical root, it is never started
automatically, it has no idle shutdown, and it binds only to `127.0.0.1`.
Registering the remote entry does not start the service. See
[`packages/service/README.md`](../service/README.md) and the
[operator guide](../../docs/operator-guide.md#shared-background-service).

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
| Recall | `search_notes`, `recall_prompt`, `list_tags`, `build_tag_wiki` |

List tools accept an optional `limit` and `tag`. Search accepts `query` plus
optional `type`, `tag`, and `limit`. Defaults and hard bounds:

- list and search: default **10**, hard maximum **50**
- tag inventory: default 50, hard maximum 200, at most 3 examples per tag
- tag wiki: default **10**, hard maximum **25**
- list/search/tag titles: at most **200** characters
- search and detail references: at most **240** characters
- search and list excerpts: at most **240** characters; wiki excerpts are
  bounded by the core wiki service

List and search do not return full note bodies. A list result is:

```json
{
  "id": "20261117193045-agent-memory-is-bounded",
  "type": "permanent",
  "title": "Agent memory is bounded",
  "createdAt": 1763407845000,
  "updatedAt": 1763408102000,
  "path": "/path/to/.slipmem/20261117193045-agent-memory-is-bounded.md",
  "excerpt": "Search results must have a hard server-side limit..."
}
```

`search_notes` returns the same summary fields plus a bounded `reference` for
literature notes. `list_tags` examples carry only IDs, types, and bounded
titles. `get_*` is the deliberate full-note read: it returns the body (subject
to the per-type storage limit) but still bounds the echoed title and reference.
The storage contract does not cap title or reference length, so these response
bounds are what keep one abusive note from dominating list, search, or tag
recall.

IDs are filename stems. `get_*` returns `{ "note": null }` for a missing,
cross-kind, or cross-root ID. `search_notes` refreshes the disposable index
before searching, so an external editor change is visible without a restart. An
empty or whitespace-only query fails with an actionable `invalid-query` error
rather than an ambiguous empty result.

`build_tag_wiki` is read-only and returns the canonical structured
`WikiPage` plus rendered Markdown. It uses the core wiki service. Extractive
mode is the default; synthesized mode requires `SLIPMEM_WIKI_SYNTHESIS` to be
configured and fails closed otherwise. A tag with no matching notes returns
an empty page with no citations and no invented content.

`recall_prompt` makes one prompt-recall call: it evaluates every eligible
permanent note independently against that prompt and returns relevant bounded
summaries plus a separate `failures` array. A failed evaluation is never
reported as irrelevant, and one note failure does not abort the other calls.
Per-note concurrency is bounded (default 4, maximum 16).

Jev/TypeSafe is an optional decision model:

```sh
SLIPMEM_RECALL_PROVIDER=jev \
TYPESAFE_API_KEY=... \
bun run --cwd packages/mcp start
```

`SLIPMEM_RECALL_PROVIDER` must be exactly `jev` or `off`; setting
`TYPESAFE_API_KEY` alone does nothing. `SLIPMEM_RECALL_JEV_MODEL` optionally
pins a different Jev model; when it is absent the pinned default `jev-1.13.0` is
used. The stdio server and the HTTP `/mcp` endpoint both resolve this from the
process environment, so one configuration serves both transports. An explicit
`recallEvaluator` option still overrides the environment.

When Jev is unset or `off`, the primary chat model configured for serving makes
the same structured relevance decision for each note. An embedding host that
deliberately runs without a serving model keeps `recall_prompt` disabled with
`evaluator-not-configured`. There is no runtime fallback between providers: an
error from a configured provider is returned as a per-note failure, never
silently retried against the other one.

Each `recall_prompt` call sends one bounded permanent note at a time — ID, title,
body, tags, and `updatedAt` — to exactly one configured provider and asks one
typed relevant/irrelevant question. No tools are offered, no JSON repair or
keyword fallback is used, and no background recall runs.

## Memory runtime and queue-driven consolidation

Serving requires an explicit tool-less OpenAI-compatible chat model. The runtime
applies to a long-running MCP serve mode: the stdio entry point (`slipmem mcp`
or `packages/mcp/src/main.ts`), the HTTP MCP endpoint mounted at `/mcp`, the web
server that mounts it, and the background `slipmem service` process. Ordinary
one-shot CLI commands do not resolve or require a model. A missing or partial configuration stops serving startup with
an actionable error; there is no production switch that restores a model-free
serve default.

There is no default provider, URL, model, or egress:

```sh
export SLIPMEM_CHAT_PROVIDER=openai-compatible
export SLIPMEM_CHAT_MODEL=...                    # required, no default
export SLIPMEM_CHAT_BASE_URL=https://provider.example/v1
export SLIPMEM_CHAT_API_KEY=...                  # optional bearer token
bun run --cwd packages/mcp start
```

The legacy `SLIPMEM_MAINTENANCE_PROVIDER`, `SLIPMEM_MAINTENANCE_MODEL`,
`SLIPMEM_MAINTENANCE_BASE_URL`, and `SLIPMEM_MAINTENANCE_API_KEY` names remain
accepted. `SLIPMEM_AUTO_MEMORY` and its interval/run-on-start variables are no
longer read and cannot disable a serving runtime. A partial chat configuration
fails startup with an actionable error.
The base URL must be HTTPS, or HTTP only for a loopback host. The tool-less
transport appends `/chat/completions` unless the path already ends there.

Consolidation is **queue-driven, not periodic**. One recovery pass runs at
startup. After that, a successful fleeting or literature write enqueues one
coalesced wake; there is no periodic timer. MCP writes in the serving process
signal the scoped Effect queue directly; a scoped note-root watcher supplies
wakes for CLI and other external writers. Durable receipts under
`.slipmem/.state/automatic-memory-revisions.json` record the source revisions
observed by a successful pass, so restarts and touch-only events do not re-send
unchanged notes. A run lease under
`.slipmem/.state/automatic-memory.lease` serializes consolidation across
processes; the repository mutation lock is never held across a provider call.

The provider receives one bounded JSON prompt containing selected fleeting or
literature source notes and existing maintenance-owned permanent candidates.
Every operation and source ID is validated by the core worker. Defaults are 12
sources and 12 candidates, each context capped at 16,000 characters; a pass is
bounded to 8 operations and 32,000 output characters. Consolidation also records
typed, evidence-backed relations in generated note metadata; `slipmem graph`
projects them read-only. The worker never deletes, reclassifies, or rewrites a
human-owned permanent note.

**Egress disclosure.** With a non-loopback base URL, that bounded note content
leaves this machine on every pass under the provider's own retention policy. With
a loopback URL, content goes only to that local endpoint. Ordinary one-shot CLI
commands perform no maintenance egress, and a missing or partial chat
configuration fails startup instead of silently disabling consolidation. The
transport is chat-completions only: it sends no tools, does not stream, requires
HTTPS except on loopback, and never logs the prompt, response body,
authorization value, or URL.

**Approval is unchanged.** Automatic maintenance is not an MCP tool. It writes
permanent notes directly with `provenance.source: maintenance`, does not create
pending proposals, and is not governed by `SLIPMEM_MCP_WRITE_POLICY`. Starting a
serve mode is the operator's explicit decision to allow that write path. Every
MCP tool write keeps the existing approval policy, and no MCP tool can approve,
reject, enable, disable, or trigger maintenance.

A failed pass is written to stderr and the next wake is attempted. A watcher
failure is reported; startup recovery covers missed external writes. The core
worker may skip individual operations that fail validation; those skips are
recorded by the worker and are not promoted to a successful write. The startup
notice states that the runtime is queue-driven, whether egress is local or
remote, and the direct-write exception.

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
tags, or `.md` files. A human applies or rejects it through the CLI, web
review page, or local HTTP API. **There is no MCP approve/reject/apply tool**,
and the MCP process is given only the `submitMcp` approval capability at runtime
and in its types. A stale proposal is refused when the note's base hash has
changed.

This is a tool-policy boundary, not an operating-system sandbox. The MCP
surface cannot approve a proposal. It does not follow that a local agent process
is unable to approve one: an agent that can run the CLI or call the local
unauthenticated HTTP API has the same access as the human operator on that
machine. Approval distinguishes MCP tool calls from human review actions; it
does not defend against a local adversary who can already read and write the
repository or control the host. Use OS-level isolation when that distinction
matters.

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
- Note text, titles, tags, links, and references are untrusted data, never
  instructions, permissions, paths, scopes, or approvals. The server never
  executes note content or follows commands found in a note.
- All recall is bounded by result count, display metadata, and excerpt length.
  Full bodies are only returned by a single-note `get_*`; there is no MCP
  bulk-edit operation.
- Approval is enforced for MCP tool calls, not by an OS sandbox. A local agent
  with CLI or HTTP access can use the human approval surfaces. Do not treat MCP
  approval as protection from a local process that already has repository
  access.
- Serving maintenance is a separate, direct permanent-write path. It writes with
  `provenance.source: maintenance`, never deletes or reclassifies, and does not
  create approval proposals. It runs only in a serving process with an explicit
  chat model; one-shot CLI commands never start it.
- Consolidation state is local bookkeeping, not memory: revision receipts, the
  run lease, and Git-capture checkpoints live under `.slipmem/.state/` and are
  never returned by MCP tools. Initiative records under `.slipmem/initiatives/`
  are separate planning data; no MCP tool reads, verifies, promotes, or
  reconciles them. A projected permanent note is ordinary memory after the CLI
  writes it.
- Note paths are validated as direct children of the note root; traversal,
  separator injection, symlinks, and cross-root IDs are rejected or reported as
  not found. Initiative and graph evidence paths are validated against their
  configured roots and never widen note trust.
- The stdio server and HTTP endpoint are local, unauthenticated interfaces. Bind
  HTTP to loopback unless you add your own access controls.

## HTTP MCP

`@slipmem/server` exports `makeMcpHttp(options)`, which uses the same
`McpNoteRegistrations` layer as stdio. The Foldkit server entry
(`packages/web/src/entry.server.ts`) mounts it at `/mcp` by default with
`extraRoutes: makeMcpHttp({ root })`. To host the API yourself:

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
| `SLIPMEM_CHAT_PROVIDER` | Required for MCP/web serving; currently `openai-compatible` |
| `SLIPMEM_CHAT_MODEL` | Required serving chat model ID; no default |
| `SLIPMEM_CHAT_BASE_URL` | Required provider base URL; HTTPS, or HTTP only on loopback |
| `SLIPMEM_CHAT_API_KEY` | Optional provider bearer token; never logged |
| `SLIPMEM_MAINTENANCE_PROVIDER` | Legacy alias for `SLIPMEM_CHAT_PROVIDER`; still accepted |
| `SLIPMEM_MAINTENANCE_MODEL` | Legacy alias for `SLIPMEM_CHAT_MODEL`; still accepted |
| `SLIPMEM_MAINTENANCE_BASE_URL` | Legacy alias for `SLIPMEM_CHAT_BASE_URL`; still accepted |
| `SLIPMEM_MAINTENANCE_API_KEY` | Legacy alias for `SLIPMEM_CHAT_API_KEY`; still accepted |
| `SLIPMEM_RECALL_PROVIDER` | `jev` selects Jev; unset or `off` uses the primary chat model, or stays disabled if none is configured |
| `SLIPMEM_RECALL_JEV_MODEL` | Optional Jev model; default `jev-1.13.0` |
| `TYPESAFE_API_KEY` | Required when `SLIPMEM_RECALL_PROVIDER=jev` |
| `XDG_CACHE_HOME` | Parent of the disposable per-root search index |
| `XDG_STATE_HOME` | Parent of per-root delete backups |

## Related memory surfaces

`slipmem capture git` reuses the primary chat model configuration by default;
per-field
`SLIPMEM_CAPTURE_*` values are optional overrides. The optional authenticated
`/api/hooks/git-push` ingress runs that capture command against a trusted local
checkout and does not expose a path, branch, or command to the caller. See
[`docs/git-capture.md`](../../docs/git-capture.md) and
[`docs/git-ingress.md`](../../docs/git-ingress.md). Capture does not deploy a
Git hook or workflow by itself.

Initiative records and the read-only note graph are separate CLI surfaces. They
are not MCP tools and initiative records are never returned by recall. A
promoted assertion can be projected by the CLI into an ordinary permanent note;
that note then participates in normal recall. See the
[operator guide](../../docs/operator-guide.md#initiative-workspaces).

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
