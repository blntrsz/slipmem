# slipmem

A local-first memory system for a person and the coding agents that work with
them. A flat Markdown repository under `.slipmem/` is the only source of truth;
the CLI, MCP server, and web app are three interfaces over the same files. A
disposable local index makes search fast but can be deleted and rebuilt at any
time.

This repository is a [Bun](https://bun.sh/) monorepo. Workspace packages live in
`packages/*`.

```sh
bun install
bun run check
```

## Quick local loop

```sh
bun run slipmem -- init
bun run slipmem -- new --type fleeting --title "First thought" --content "Capture it"
bun run slipmem -- list
bun run slipmem -- search thought
bun run web
```

`bun run web` serves the Foldkit UI, the canonical ID-based JSON API under
`/api`, and the HTTP MCP endpoint at `/mcp` in one process. The repository's
`opencode.json` registers the stdio MCP server for OpenCode; that serve path
also needs the chat-model environment described below or startup fails.

The one-shot CLI commands above stay local and need no model. `bun run web` is a
serving process and requires the explicit chat-model configuration described in
[Web and network posture](#web-and-network-posture); missing or partial
configuration stops startup.

## Shared background service (optional)

`slipmem service` runs one loopback HTTP service per canonical note root. It owns
the same scoped consolidation worker as the web entry, so consolidation keeps
running after every MCP client disconnects. Nothing starts a service
automatically: the default `opencode.json` stdio entry remains standalone and is
never silently attached to a background URL. No service runs for a note root
until an operator starts one.

```sh
bun run slipmem -- service start --port 4319   # stable URL for a remote client
bun run slipmem -- service status --json
bun run slipmem -- service stop
```

`start` resolves the root, canonicalizes it with `realpath`, and reuses an
already-ready service for that root. There is one service (one consolidation
consumer) per canonical root. `start` requires the same serving chat model as
MCP/web unless a matching service is already running; `status` and `stop` never
resolve a model. There is no idle shutdown: the service runs until `stop` or
process death. It binds only to `127.0.0.1` by construction, ignores inherited
`HOST` and `PORT`, and leaves `/api` and `/mcp` unauthenticated, so do not proxy
or expose the port.

To point OpenCode at the stable endpoint instead of stdio, replace the local
server entry with a remote one. Slipmem does not offer OAuth for this endpoint,
so disable it:

```json
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

`--port` overrides `SLIPMEM_SERVICE_PORT`; an unset or `0` value asks the
operating system for a fresh loopback port. `SLIPMEM_SERVICE_START_TIMEOUT_MS`
bounds the readiness wait. See [`packages/service/README.md`](packages/service/README.md)
and the [operator guide](docs/operator-guide.md#shared-background-service).

## Storage

- Every new note is one direct child of `.slipmem/`, named
  `<kebab-slug>.md`; the filename stem is the stable ID. Collisions get `-2`,
  `-3`, and so on. Existing `YYYYMMDDHHmmss-<kebab-slug>.md` names remain valid
  and are not renamed.
- Type, title, timestamps, tags, provenance, and optional source live in YAML
  frontmatter. Unknown keys are preserved.
- Local state such as pending approvals, consolidation receipts, run leases,
  and Git-capture checkpoints lives under `.slipmem/.state/` and is gitignored.
  Pending proposals are never notes.
- Initiative records live under `.slipmem/initiatives/`, a nested directory that
  is never scanned as notes and never enters the search index, recall, or
  approval queue.
- The search index lives under `$XDG_CACHE_HOME/slipmem/` and contains derived
  data only.
- `SLIPMEM_DIR` overrides the root; otherwise the nearest ancestor `.slipmem/`
  is used. A missing root fails startup instead of creating or importing one.
- Migrating from the old SQLite store is a separate, non-destructive command.
  SQLite is not the runtime source of truth. `SLIPMEM_DB_PATH` is deprecated:
  it names only the legacy SQLite file for `migrate sqlite` and the
  compatibility window, never the live note store. Any older documentation
  that describes SQLite as the runtime store is superseded by this README.

## Packages

- `packages/schemas` — Effect Schema note slices and the frozen Markdown
  filename, metadata, approval, and wiki contracts.
- `packages/core` — Markdown repository, safe parser, atomic writes, locking,
  disposable FTS index, approval service, wiki service, model transport,
  queue-driven maintenance and graph, initiative records, and migration
  importer.
- `packages/cli` — the `slipmem` executable for init, capture, curation, search,
  review, wiki, graph, initiatives, check, and migration. `capture git` is the
  main-push adapter.
- `packages/mcp` — MCP tools and stdio transport over the shared core services.
- `packages/server` — canonical JSON API, compatibility adapters, HTTP MCP
  mounting, and the Markdown layer wiring.
- `packages/service` — one background loopback HTTP service per canonical note
  root, owning the shared API, HTTP MCP endpoint, and consolidation worker.
- `packages/web` — Foldkit SSR app for list, detail, create, edit, delete,
  search, tags, wiki, review, and health.

## Web and network posture

```sh
bun run web        # Vite development host
bun run web:build
PORT=3000 bun run web:serve
```

The web server binds to `127.0.0.1` by default. The API is unauthenticated and
note files are plaintext and unencrypted. Setting `HOST` to a non-loopback
address is an explicit decision to expose every note to the network and prints
a warning. Mutations are same-origin only and require JSON; no CORS access is
enabled. Note text is untrusted data and is rendered as text/Markdown, never
trusted HTML.

Agent writes use a local approval policy. MCP permanent creates, updates, and
reclassifications, plus all MCP deletes, become pending proposals that a human
approves or rejects at `/review`; MCP fleeting and literature creates and
updates are direct. The exact matrix is in
[`packages/mcp/README.md`](packages/mcp/README.md#approval-and-write-policy),
which also documents the unsafe trusted-automation direct-write escape hatch,
and in the [operator guide](docs/operator-guide.md#write-approval-policy). That
is not authentication and not an OS sandbox. It does not stop another local
process that can reach the loopback port from reading or writing notes; the
loopback bind and file permissions are the real boundary.

Extractive tag pages are always available and quote their cited sources.
Synthesized mode is opt-in and only works when this process has an explicitly
configured local agent or a registered model adapter. A configured agent is
normally run inside a probed OS sandbox; `SLIPMEM_WIKI_AGENT_UNSAFE=1` is an
explicit unsafe override that runs it with the slipmem user's full filesystem
privileges. The Health page reports whether synthesis is configured and the
web UI does not advertise it otherwise.

**Serving requires an explicit model.** Serving is model-backed and
queue-driven. The MCP stdio server, the HTTP `/mcp` endpoint, the web server
(`bun run web` and `bun run web:serve`), and `slipmem service` require an
explicit OpenAI-compatible chat model
(`SLIPMEM_CHAT_PROVIDER`, `SLIPMEM_CHAT_MODEL`, `SLIPMEM_CHAT_BASE_URL`, and an
optional `SLIPMEM_CHAT_API_KEY`); there is no default provider, URL, or model,
and a missing or partial configuration stops startup. The old
`SLIPMEM_AUTO_MEMORY` switch no longer disables a serving runtime. Ordinary
one-shot CLI commands stay local and do not require a model.

Once serving, in-process fleeting and literature writes wake consolidation
immediately, external writes are watched, a startup pass recovers unfinished
work, and there is no periodic scan. A separate decision model (Jev) is
optional; without it, the configured chat model makes each structured
`recall_prompt` decision, and a configured provider failure is reported instead
of silently falling back.

Capture paths that feed the queue are: direct fleeting writes through the CLI
or MCP; `slipmem capture git`, which turns a verified `before..after` main-push
delta into evidence-pinned fleeting sources and a local checkpoint while using
only read-only Git object queries and without modifying the source checkout (it
inherits the primary chat model configuration, with optional `SLIPMEM_CAPTURE_*`
overrides); and an optional separately authenticated
`/api/hooks/git-push` ingress that accepts only exact commit SHAs and runs that
capture command against a trusted local checkout. Capture's writes are limited
to the fleeting notes and checkpoint under the note root. None of these paths
commits, pushes, checks out, fetches, resets, rewrites history, or deploys a Git
hook or workflow by itself. Initiatives are separate durable planning records
under `.slipmem/initiatives/`. The records stay outside normal recall;
`slipmem initiative` tracks scope, milestones, and assertions; on request, it
reports each assertion as supported, contradicted, or not evidenced, and it
promotes one clearly supported assertion at a time once its evidence is
reachable from `main`. A landed promotion can be projected into one permanent note through the
same CLI; the projection is reused and never overwrites an existing note. It does
not verify or promote automatically, is not Spec Kit, and adds no blocking CI
gate.

Existing MCP tool writes keep their approval policy: no MCP tool can approve,
reject, enable, disable, or trigger consolidation. Maintenance and Git capture
are separate direct-write paths with their own provenance and bounds. See the
[operator guide](docs/operator-guide.md#memory-runtime-and-queue-driven-consolidation)
for the exact environment, egress, recovery, and limits. The capture contract is
in [`docs/git-capture.md`](docs/git-capture.md); the optional authenticated
handoff is in [`docs/git-ingress.md`](docs/git-ingress.md).

See [`packages/server/README.md`](packages/server/README.md),
[`packages/web/README.md`](packages/web/README.md), and
[`docs/mvp-plan.md`](docs/mvp-plan.md) for the API, UI routes, approval flow,
tag pages, and acceptance criteria. The `docs/mvp-*-evidence.md` pages and
sections 0-10 of the [acceptance matrix](docs/mvp-acceptance-matrix.md) are
frozen evidence at named commits, not current behavior; this README and the
[operator guide](docs/operator-guide.md) describe the current tree.
