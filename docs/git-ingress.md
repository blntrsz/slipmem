# Git push ingress (opt-in, privileged)

Status: **implemented as an opt-in HTTP surface**, 2026-11-22. The default
server has no such route. This page describes the only deployment shape that
the code supports: a persistent slipmem process with a trusted local checkout,
not a GitHub-hosted runner that writes throwaway note files.

## What it is, and is not

`POST /api/hooks/git-push` is a narrow, separately authenticated ingress for a
trusted automation job. The caller forwards only exact commit SHAs:

```json
{ "before": "<40-or-64-lowercase-hex>", "after": "<40-or-64-lowercase-hex>", "commits": ["<sha>"] }
```

`commits` is optional and bounded; duplicate entries are removed. Any other
field is rejected. The caller can never send a repository path, a branch name,
a tag, a diff, a note root, a command, or an environment value. The 16 KiB body
cap is enforced while streaming, so an oversized body is not buffered first.

The ingress is **not** a GitHub webhook receiver. Do not forward the raw GitHub
push payload. It is also not a replacement for the unauthenticated local JSON
API or `/mcp`; those remain localhost surfaces.

## Components

1. A trusted GitHub event source (self-hosted runner, a small poller, or a
   provider webhook adapter) learns a push `before`/`after`.
2. That source updates a dedicated persistent checkout to `after` and calls the
   ingress with the two SHAs and the bearer token.
3. The ingress validates the token, the SHA-only body, its bounds, and runs the
   operator-configured, first-party `slipmem capture git` command with that
   trusted checkout as its working directory. The executable is installed
   outside the checkout (never a script from the pushed tree).
4. The capture command verifies the Git range, calls the configured capture
   model, and writes durable fleeting notes plus a checkpoint. It never writes
   to the source checkout.
5. The same slipmem process watches the note root. When the capture notes are
   durable, the event-driven maintenance runtime wakes and consolidates them
   with the serving primary chat model. Startup recovery covers a missed watch.

The durable handoff is the note files, not an in-memory HTTP response. A
restart after the capture write does not lose the source; a restart before the
write means the caller should retry the same SHA-only event.

## Required configuration

Serving (`/mcp` and consolidation) requires an explicit primary chat model.

```sh
SLIPMEM_CHAT_PROVIDER=openai-compatible
SLIPMEM_CHAT_MODEL=...
SLIPMEM_CHAT_BASE_URL=https://provider.example/v1
SLIPMEM_CHAT_API_KEY=...                 # optional
```

Capture uses the shared primary chat model unless a capture-specific value
overrides it. The precedence per field is `SLIPMEM_CAPTURE_*`, then
`SLIPMEM_CHAT_*`, then the legacy `SLIPMEM_MAINTENANCE_*` aliases. A deployment
that already configured the serving model therefore does not need a second
model block.

```sh
SLIPMEM_CAPTURE_PROVIDER=openai-compatible   # optional override
SLIPMEM_CAPTURE_MODEL=...                    # optional override
SLIPMEM_CAPTURE_BASE_URL=...                 # optional override
SLIPMEM_CAPTURE_API_KEY=...                   # optional override
```

The ingress itself is absent unless all of these resolve:

```sh
SLIPMEM_GIT_INGRESS=on
SLIPMEM_GIT_INGRESS_TOKEN=...            # at least 32 characters, random
# or: SLIPMEM_GIT_INGRESS_TOKEN_FILE=/run/secrets/slipmem-git-ingress
SLIPMEM_GIT_INGRESS_REPO=/srv/slipmem-checkout
SLIPMEM_GIT_INGRESS_COMMAND='["/opt/slipmem/bin/bun","/opt/slipmem/libexec/slipmem/packages/cli/src/main.ts","capture","git","--before","{before}","--after","{after}","--repo","{repository}","--json"]'
SLIPMEM_GIT_INGRESS_TIMEOUT_MS=120000    # optional; 1s..10m
SLIPMEM_GIT_INGRESS_MAX_COMMITS=20       # optional; 1..100
```

`SLIPMEM_GIT_INGRESS_TOKEN` and `SLIPMEM_GIT_INGRESS_TOKEN_FILE` are mutually
exclusive. The command is an operator-configured argv array, never a shell
string from a caller. `{before}` and `{after}` are required; `{repository}` is
replaced with the canonical trusted root.

The capture child receives the server's note root as `SLIPMEM_DIR` and the
selected SHAs as `SLIPMEM_GIT_BEFORE`, `SLIPMEM_GIT_AFTER`,
`SLIPMEM_GIT_REPOSITORY`, and `SLIPMEM_GIT_COMMITS`. It receives only an
allowlist of safe runtime variables (`PATH`, `HOME`, temp/XDG directories,
locale/timezone, and TLS trust paths) plus the `SLIPMEM_CAPTURE_*`,
`SLIPMEM_CHAT_*`, and legacy `SLIPMEM_MAINTENANCE_*` model settings. The ingress
token and every unrelated ambient credential in the server process are removed.

### Command trust

Run the **first-party installed** `slipmem capture git` command from a
read-only, operator-owned installation (for example `/opt/slipmem/...`), with
absolute paths. Do not point the command at a script, binary, `node_modules`
tree, or wrapper inside the pushed checkout: that would turn a SHA push into
arbitrary repository-code execution.

The first-party capture command verifies exact commit SHAs, requires `HEAD` to
equal `after`, requires `after` to descend from `before`, and reads Git objects
only with read-only commands. It never fetches, checks out, resets, cleans, runs
repository hooks, or executes a file from the delta. See
[`docs/git-capture.md`](git-capture.md#safety-contract) for the full contract.
The ingress adds no commit execution of its own; it only substitutes the two
validated SHAs and the configured trusted root into the operator's argv.

## Checkout and deployment rules

- The trusted checkout must be a worktree whose `HEAD` equals `after`. The
  capture CLI verifies this and refuses to fetch, reset, clean, or check out.
  Update the checkout in a trusted updater or wrapper before calling capture.
- Use a persistent host or a self-hosted runner with a persistent note root.
  A workflow that writes notes only to the runner's temporary filesystem is not
  a deployment: those files disappear when the job ends.
- Do not expose the whole web server. Terminate TLS at a reverse proxy and route
  only `/api/hooks/git-push` to the loopback server. `/api` and `/mcp` are
  intentionally unauthenticated and must not be exposed with the ingress.
- Rotate the ingress token independently of provider keys. The token is never
  logged, echoed, or passed to the capture command.
- Keep the ingress disabled unless an operator has reviewed the capture model's
  egress boundary. Remote capture sends bounded diff content to that provider.

## Status codes

| Status | Meaning |
| --- | --- |
| `200` | Capture command exited zero; durable capture notes are available |
| `400` | Non-SHA field, short/tag/zero SHA, too many commits, or malformed JSON |
| `401` | Missing or wrong bearer token |
| `403` | Browser `Origin` header, or cross-origin attempt |
| `413` | Body larger than 16 KiB |
| `415` | Body is not `application/json` |
| `429` | Four captures are already running/queued; retry later |
| `502` | Capture command failed; output is suppressed |
| `504` | Capture command exceeded the configured timeout |

The capture CLI writes idempotent markers and a checkpoint, so retrying the same
SHA pair is safe. The ingress does not retry by itself.

## Programmatic fixture

Hosts and tests can mount the handler without a live command:

```ts
const handler = makeGitIngressHandler({
  config,
  noteRoot,
  maintenanceEnabled: true,
  run: async (input) => ({ exitCode: 0, timedOut: false, outputTruncated: false }),
})
```

`run` receives only the canonical repository root, the note root, exact SHAs,
and an abort signal. Production uses the configured trusted command.

## CI example on a persistent host

This example assumes a **self-hosted runner on the same host** as the slipmem
server. The runner updates the trusted checkout, then asks the local ingress to
capture. The note root is the host's persistent `.slipmem/` directory, not a
runner temporary directory.

```yaml
name: capture-memory

on:
  push:
    branches: [main]

jobs:
  capture:
    runs-on: [self-hosted, slipmem-host]
    steps:
      - name: Skip the all-zero first-push sentinel
        if: ${{ github.event.before != '0000000000000000000000000000000000000000' }}
        env:
          SLIPMEM_GIT_INGRESS_REPO: /srv/slipmem-checkout
          SLIPMEM_GIT_INGRESS_TOKEN: ${{ secrets.SLIPMEM_GIT_INGRESS_TOKEN }}
          BEFORE: ${{ github.event.before }}
          AFTER: ${{ github.event.after }}
        run: |
          set -eu
          git -C "$SLIPMEM_GIT_INGRESS_REPO" fetch --prune origin
          git -C "$SLIPMEM_GIT_INGRESS_REPO" checkout --detach "$AFTER"
          curl --fail-with-body --silent --show-error \
            -H "authorization: Bearer $SLIPMEM_GIT_INGRESS_TOKEN" \
            -H "content-type: application/json" \
            --data "{\"before\":\"$BEFORE\",\"after\":\"$AFTER\"}" \
            "http://127.0.0.1:3000/api/hooks/git-push"
```

The job is a trigger and checkout updater. The actual capture and note writes
happen in the long-lived server process against its persistent note root. If
you cannot run a self-hosted runner, use an equivalent trusted poller that
updates the checkout and calls the same endpoint; do not deploy a workflow that
only writes notes to the runner's temporary workspace.
