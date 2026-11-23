# @slipmem/service

One background HTTP service per canonical Markdown note root. It owns the same
scoped consolidation worker that the web entry mounts, so the worker keeps
running after every MCP client disconnects.

This is the first honest slice: one process per canonical `.slipmem` root.
There is no cross-root registry, no shared multi-root process, and no idle
eviction.

## Lifecycle

```sh
slipmem service start  [--dir <path>] [--port <n>] [--json]
slipmem service status [--dir <path>] [--json]
slipmem service stop   [--dir <path>] [--json]
```

- `start` resolves the note root, canonicalizes it with `realpath`, and
  reuses an already-ready service for that root. Two simultaneous starts
  coordinate through a short-lived start lock, then the child holds a lifetime
  owner record. A stale registration is replaced only after PID identity (or,
  where `/proc` is unavailable, the HTTP instance ID) proves the old process is
  gone.
- `status` reports `running`, `ready`, and a bounded reason when the process is
  alive but its health endpoint is not ready. It never resolves a model.
- `stop` verifies PID identity plus the registered instance ID before sending
  anything. It refuses a reused PID and forces `SIGKILL` only after the normal
  timeout. It never resolves a model.
- No idle timer evicts the service. It stays until `stop` or process death.

Readiness is `GET /service/health` on the loopback listener; it returns the
canonical root, PID, instance ID, and start time. `GET /api/health` is also
available through the reused server.

## Composition

The child imports the existing `@slipmem/server` composition:

- `makeApiHandler(root, { extraRoutes: makeMcpHttp({ root, ... }) })`
- the same canonical JSON API as the web entry
- the same HTTP MCP endpoint and one scoped maintenance worker

It does not duplicate tool registrations, approval policy, or the maintenance
queue. The default stdio server is unchanged; running it still starts its own
serve runtime unless an operator chooses the explicit shared endpoint.

## Explicit shared endpoint

Use a stable port when an MCP client needs a fixed URL:

```sh
slipmem service start --port 4319
slipmem service status --json
```

`--port` overrides `SLIPMEM_SERVICE_PORT`; `0` or an unset value asks the
operating system for a fresh loopback port. `SLIPMEM_SERVICE_START_TIMEOUT_MS`
optionally bounds the readiness wait.

The status/start JSON includes `url` and `mcpUrl`. For OpenCode, an explicit
remote server entry is:

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

OpenCode enables OAuth for remote servers by default. This endpoint offers no
OAuth, so set `oauth: false`; the loopback bind and filesystem permissions are
the boundary.

This is an explicit client mode. `slipmem` does not silently attach the default
stdio command to a random background service, does not start a service
automatically, and does not replace an existing stdio entry. Only one service
(or consolidation consumer) owns a canonical root, and it has no idle shutdown.

## State and security

Local state lives under `<root>/.state/service/`:

| File | Purpose |
| --- | --- |
| `state.json` | Ready registration: canonical root, PID, process identity, instance ID, URL, port, start time |
| `owner.json` | Lifetime per-root owner lock, including a not-yet-ready child |
| `start.lock` | Short-lived concurrent-start coordination |
| `service.log` | Child stdout/stderr; startup failures are surfaced from its tail |

The child binds only to `127.0.0.1` by construction; inherited `HOST` and
`PORT` are ignored. The API and `/mcp` are still unauthenticated, as before.
Do not expose this port through a proxy or a non-loopback bind. The loopback
bind and filesystem permissions remain the real boundary.

Starting a service requires the same explicit serving chat model as MCP/web. A
missing or partial configuration fails before a child is started. Tests and
local development should use a loopback fake provider, never a live provider.
