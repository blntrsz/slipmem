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
`opencode.json` registers the stdio MCP server for OpenCode.

## Storage

- Every note is one direct child of `.slipmem/`, named
  `YYYYMMDDHHmmss-<kebab-slug>.md`; the filename stem is the stable ID.
- Type, title, timestamps, topics, provenance, and optional source live in YAML
  frontmatter. Unknown keys are preserved.
- Local state such as pending approvals lives under `.slipmem/.state/` and is
  gitignored. Pending proposals are never notes.
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
  disposable FTS index, approval service, wiki service, and migration importer.
- `packages/cli` — the `slipmem` executable for init, capture, curation, search,
  review, wiki, check, and migration.
- `packages/mcp` — MCP tools and stdio transport over the shared core services.
- `packages/server` — canonical JSON API, compatibility adapters, HTTP MCP
  mounting, and the Markdown layer wiring.
- `packages/web` — Foldkit SSR app for list, detail, create, edit, delete,
  search, topics, wiki, review, and health.

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

Agent writes use a local approval policy: MCP mutations become pending
proposals that a human approves or rejects at `/review`. That is not
authentication and not an OS sandbox. It does not stop another local process
that can reach the loopback port from reading or writing notes; the loopback
bind and file permissions are the real boundary.

Extractive topic pages are always available and quote their cited sources.
Synthesized mode is opt-in and only works when this process has an explicitly
configured local agent or a registered model adapter. A configured agent is
normally run inside a probed OS sandbox; `SLIPMEM_WIKI_AGENT_UNSAFE=1` is an
explicit unsafe override that runs it with the slipmem user's full filesystem
privileges. The Health page reports whether synthesis is configured and the
web UI does not advertise it otherwise.

See [`packages/server/README.md`](packages/server/README.md),
[`packages/web/README.md`](packages/web/README.md), and
[`docs/mvp-plan.md`](docs/mvp-plan.md) for the API, UI routes, approval flow,
topic pages, and acceptance criteria.
