# Main-push Git delta capture

Status: **implemented opt-in CLI/CI adapter**, 2026-11-22. This page describes
the first deployable slice. There is no active GitHub workflow or committed
secret in this repository. An opt-in authenticated HTTP ingress exists as a
separate server slice; it is documented in [`docs/git-ingress.md`](git-ingress.md)
and is not a GitHub webhook receiver.

The adapter turns one verified main-branch push delta into bounded, evidence-
backed fleeting notes and a durable checkpoint. It is for a GitHub Actions job
or any CI runner that can pass the push event's exact `before` and `after`
commits. It is not a Git hook and it does not commit, fetch, reset, or push.

## Safety contract

`slipmem capture git` enforces all of the following before it calls a model or
writes a note:

- `--before` and `--after` must be exact lowercase 40- or 64-character commit
  SHAs. Branches, tags, short SHAs, and the all-zero creation/deletion sentinel
  are rejected.
- Both commits must already exist in the checkout. Capture never fetches
  objects, so a shallow checkout must be configured with full history.
- `HEAD` must equal `--after`. The checked-out tree is trusted only as the
  source of immutable Git objects; capture does not read working-tree files.
- `--after` must descend from `--before`. A force push, branch replacement, or
  reversed range is refused rather than turned into a fabricated delta.
- Git commands are read-only (`rev-parse`, `cat-file`, `merge-base`, `diff`).
  System and global Git configuration are ignored, lazy fetching, external
  diffs, textconv, pagers, and prompts are disabled, and capture runs with
  `--no-pager`.
- The changed-path list and every file patch are bounded. Renames are treated
  as delete/add pairs; binaries and oversized files are listed as omitted
  rather than silently truncated. Omitted-path details are capped (32 rows) and
  accompanied by an aggregate count in the prompt and report.
- The model payload contains only the repository basename, not the absolute
  checkout path.
- The note root's own prefix is excluded from the delta, so committed capture
  notes cannot feed the next capture.

### Trusted checkout

Treat the checkout as a trusted main-branch input. Capture reads immutable Git
objects only, never working-tree files, and never runs repository hooks. Because
a repository-controlled `.git/config` or attributes file can request external
programs, every Git call also forces `core.fsmonitor=false`,
`core.hooksPath=/dev/null`, `core.attributesFile=/dev/null`,
`--no-ext-diff`, and `--no-textconv`, and the adapter strips inherited Git
environment variables. Use a checkout with no
persisted credentials and do not run this adapter on an untrusted pull-request
merge or a directory another process can rewrite concurrently. A failed
verification or malformed object fails closed.

Capture never holds the repository mutation lock across a model call.
Repository writes use the existing short-lived create lock; the optional
consolidation lock is separate.

## Authoritative notes and deployment modes

> **A capture run in an ephemeral GitHub-hosted checkout updates only that
> checkout.** It does not update the authoritative note root, and Slipmem never
> auto-commits or pushes notes back to Git.

Choose one deployed mode:

1. **Self-hosted runner with the authoritative note root mounted (recommended
   first slice).** Check out the source repository read-only and pass
   `--dir /absolute/path/to/authoritative/.slipmem`. The source delta comes from
   the checkout; notes and `.state/` land on durable storage.
2. **Authenticated HTTP ingress to a service-owned note root (separate opt-in
   server slice).** See [`docs/git-ingress.md`](git-ingress.md). The ingress
   accepts a SHA-only body behind a separate bearer token, runs this capture
   command in an operator-configured trusted checkout, and sets the server's
   authoritative note root as `SLIPMEM_DIR`. It never accepts a filesystem path,
   branch, diff, or command from the caller. It is not a GitHub webhook; a
   trusted adapter job must forward the exact push SHAs.
3. **Ephemeral runner plus an explicit artifact/commit step outside Slipmem.**
   This is not an authoritative update by itself. If an operator later commits
   captured notes, that is their own Git operation; Slipmem never performs it.

On an ephemeral runner the local checkpoint under `.state/` is disposable.
Idempotency does not depend on it: every created fleeting note carries a
`gitCapture` marker with a content-addressed key, so a fresh checkout and a
repeated delivery still do not duplicate sources.

## Configuration

The model boundary is explicit and required. There is no default provider, URL,
model, or automatic egress. The request is a tool-less OpenAI-compatible
`/chat/completions` call through `@slipmem/core/model`.

Capture accepts the shared primary chat configuration, so a deployment that
already serves automatic memory with `SLIPMEM_CHAT_*` does not need a separate
capture model configuration. Capture-specific `SLIPMEM_CAPTURE_*` values take
precedence per field; missing values fall back to `SLIPMEM_CHAT_*`, then the
legacy `SLIPMEM_MAINTENANCE_*` names. The HTTP Git ingress resolves its startup
model with the same fallback.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLIPMEM_CAPTURE_PROVIDER` | fallback | Must be `openai-compatible`. Falls back to `SLIPMEM_CHAT_PROVIDER`, then `SLIPMEM_MAINTENANCE_PROVIDER`. |
| `SLIPMEM_CAPTURE_MODEL` | fallback | Exact model identifier sent to the provider. Falls back to `SLIPMEM_CHAT_MODEL`, then `SLIPMEM_MAINTENANCE_MODEL`. |
| `SLIPMEM_CAPTURE_BASE_URL` | fallback | HTTPS base URL, or HTTP only on a loopback host. No default. Falls back to `SLIPMEM_CHAT_BASE_URL`, then `SLIPMEM_MAINTENANCE_BASE_URL`. |
| `SLIPMEM_CAPTURE_API_KEY` | no | Optional bearer token. Falls back to `SLIPMEM_CHAT_API_KEY`, then `SLIPMEM_MAINTENANCE_API_KEY`. Keep it in the environment; never pass it in argv. |
| `SLIPMEM_CAPTURE_TIMEOUT_MS` | no | Per-call timeout, bounded by the shared transport. |
| `SLIPMEM_CAPTURE_MAX_RESPONSE_BYTES` | no | Per-call response bound, bounded by the shared transport. |
| `SLIPMEM_CAPTURE_MAX_FILES` | no | `1`-`100` changed files included; default `24`. |
| `SLIPMEM_CAPTURE_MAX_HUNKS` | no | `1`-`50` hunks per file; default `20`. |
| `SLIPMEM_CAPTURE_MAX_FILE_CHARS` | no | `1000`-`50000` patch characters per file; default `12000`. |
| `SLIPMEM_CAPTURE_MAX_DIFF_CHARS` | no | `2000`-`200000` total patch characters; default `60000`. |
| `SLIPMEM_CAPTURE_MAX_HUNK_LINE_CHARS` | no | `200`-`8000` characters in one diff line; default `2000`. A longer line omits its whole hunk. |
| `SLIPMEM_CAPTURE_MAX_SOURCES` | no | `1`-`8` fleeting sources per run; default `4`. |
| `SLIPMEM_CAPTURE_MAX_EVIDENCE` | no | `1`-`8` evidence items per source; default `4`. |

Remote endpoints are disclosed in human output and JSON as `model.egress =
"remote"`. The bounded diff leaves the machine on every such run. A local
loopback endpoint is reported as `local`.

## Usage

```sh
slipmem capture git \
  --before "$BEFORE_SHA" \
  --after "$AFTER_SHA" \
  --repo /path/to/source-checkout \
  --dir /path/to/authoritative/.slipmem \
  --json
```

- `--repo` defaults to the current directory.
- `--dir` is the normal global note-root option.
- `--consolidate` is optional and off by default. Without it, capture writes
  durable fleeting sources and a checkpoint; the configured memory runtime
  picks them up on its next durable scan. With it, capture is rejected if the
  shared `automatic-memory.lease` is held by a live consolidator.
- Use `--consolidate=false` explicitly only for readability. `--consolidate`
  without a value enables the one-shot path.

The command exits `0` for a captured or no-op delta, `1` for a verification,
model, evidence, or write failure, and `2` for CLI usage errors. A `--json`
result includes the verified range, diff summary, omitted files, source IDs,
skipped model sources, checkpoint path/status, model egress, and consolidation
status. Errors are JSON envelopes on stderr.

## Model output and evidence validation

The model receives only bounded commit identifiers and unified-diff hunks. It
must return JSON shaped as:

```json
{
  "sources": [
    {
      "title": "Short durable claim",
      "content": "Why this matters after the diff is forgotten.",
      "tags": ["architecture"],
      "evidence": [
        {
          "commit": "<exact after SHA>",
          "path": "packages/core/src/example.ts",
          "hunk": 0,
          "quote": "exact changed line text"
        }
      ]
    }
  ]
}
```

Each source is rejected whole when:

- `commit` is not the exact `after` SHA;
- `path` is not a changed path in the bounded request;
- `hunk` is not a listed zero-based hunk index for that path;
- `quote` is not a literal substring of exactly one changed (`+`/`-`) line in
  that hunk, or the quote contains a newline. Quotes are never matched across
  stitched or separated changed lines;
- the title, content, tags, or evidence count exceeds a configured bound.

Output is parsed as strict JSON. It is not repaired, retried, or escaped into
Markdown fences. If the model supplied sources but none cited valid evidence,
the run fails with `evidence-invalid` and writes no note. A genuine
`{"sources":[]}` is accepted as a no-op.

## Idempotency and checkpoint

Each fleeting note is created with provenance `source: cli`,
`actor: slipmem-git-capture`, and unknown frontmatter:

```yaml
gitCapture:
  version: 1
  key: <sha256 of range, title, content, tags, and evidence>
  repository: <sha256 of the absolute repository path>
  before: <exact SHA>
  after: <exact SHA>
  capturedAt: <UTC timestamp>
  evidence: [...]
```

Before creating a source, capture scans note frontmatter for the same key. This
makes repeated webhook deliveries and reruns idempotent, including on a fresh
checkout with no local checkpoint. Malformed markers are ignored, never
repaired.

The local checkpoint is written atomically to:

```text
<note-root>/.state/git-capture/<repository-key>.json
```

The repository key is derived from the canonical absolute repository path. Keep
that path stable across ephemeral reruns for checkpoint reuse; note markers are
also keyed by it, so a changed checkout path is treated as a different
repository identity.

It records the exact range, source IDs/keys, status (`captured` or
`consolidated`), and optional consolidation counts. A matching checkpoint whose
source notes still exist lets a rerun skip the capture model call. If a
checkpoint source is missing or its marker no longer matches, capture recaptures
instead of trusting the checkpoint. A malformed checkpoint is ignored with a
warning. To force a recapture, remove that checkpoint file; note markers still
prevent duplicate sources.

## Consolidation integration

The capture adapter does **not** own consolidation by default. It:

1. verifies the range and bounded delta;
2. calls the tool-less capture chat once;
3. writes idempotent fleeting sources and the checkpoint.

A runtime that owns the authoritative note root can pick those sources up on its
next startup or periodic durable scan, using the same permanent-maintenance
machinery. No queue signal is required by this slice because the source notes
are the durable jobs. The opt-in HTTP ingress uses this same path: its capture
command template
(`... capture git --before {before} --after {after} --repo {repository}`)
receives the server's note root through `SLIPMEM_DIR`, and the in-process
maintenance watcher drains the durable sources. Omit `--consolidate` in that
ingress command so the runtime remains the single consolidation owner.

`--consolidate` is a one-shot escape hatch for a deployment with **no** runtime
owner. It invokes the same `makePermanentMaintenanceWorker` immediately after
source persistence. It uses the same cross-process
`<note-root>/.state/automatic-memory.lease` as the serving runtime, so a CLI
consolidation is rejected while a live owner (runtime or another CLI) holds the
lease, and the runtime waits while the CLI holds it. That lease is not the
repository mutation lock and is not held during source writes.

Use exactly one consolidation owner:

- **runtime-owned mode:** do not pass `--consolidate`; let the runtime scan;
- **CLI-owned mode:** ensure no long-lived runtime is configured for the same
  note root, and pass `--consolidate` when immediate draining is required.

Do not run both against one note root. A live lease makes `--consolidate` fail
before capture writes anything; sources from an earlier run stay durable. If
consolidation fails after sources were saved, the checkpoint remains
`captured`; retrying the same range reuses the sources and retries
consolidation.

## GitHub Actions `on.push` example (documentation only)

This is an example, not an active workflow in this repository. It uses a
self-hosted runner with the authoritative note root already mounted, full
history for both push SHAs, no persisted checkout credentials, and no workflow
write permission.

```yaml
name: Capture main push
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  capture:
    runs-on: [self-hosted, linux, slipmem-notes]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Capture the verified push delta
        env:
          SLIPMEM_CAPTURE_PROVIDER: openai-compatible
          SLIPMEM_CAPTURE_MODEL: your-explicit-model
          SLIPMEM_CAPTURE_BASE_URL: https://your-provider.example/v1
          SLIPMEM_CAPTURE_API_KEY: ${{ secrets.SLIPMEM_CAPTURE_API_KEY }}
        run: |
          bun run slipmem capture git \
            --before "${{ github.event.before }}" \
            --after "${{ github.sha }}" \
            --repo "$GITHUB_WORKSPACE" \
            --dir /srv/slipmem/notes/.slipmem \
            --json
```

Notes:

- `fetch-depth: 0` is needed so both commits exist locally. Capture never
  fetches and never modifies the checkout.
- The job may export the shared `SLIPMEM_CHAT_PROVIDER`,
  `SLIPMEM_CHAT_MODEL`, `SLIPMEM_CHAT_BASE_URL`, and optional
  `SLIPMEM_CHAT_API_KEY` instead of the capture-specific names.
- `--dir` must point at the authoritative, durable note root. Do not rely on a
  path inside `$GITHUB_WORKSPACE` on a GitHub-hosted runner.
- The secret is injected from the runner's secret store; it is never written to
  argv or a note.
- No workflow step commits or pushes captured notes. A human or a separate
  explicitly designed service owns that action.
- If the runtime owns consolidation, omit `--consolidate`.

## Recovery

- **`commit-missing`:** fetch full history for the pushed range; capture will not
  fetch.
- **`checkout-mismatch`:** check out the pushed `after` commit. The adapter reads
  only that checkout's Git objects.
- **`not-ancestor`:** the event is a force push or replacement. This slice
  refuses it; handle it with a deliberate full-history policy rather than a
  misleading small delta.
- **`consolidation-locked`:** another consolidation, from a serving runtime or
  another CLI run, holds the shared `automatic-memory.lease`. Sources are
  already durable. Retry after it finishes, or remove the lease if the previous
  process was killed.
- **Malformed checkpoint:** delete it and rerun. Existing note markers still
  make source creation idempotent.

## Not implemented

- a signed GitHub webhook receiver or signature verifier (the authenticated
  ingress is a separate, opt-in SHA-forwarding endpoint, not a webhook);
- a cross-process job queue or signal protocol (durable notes plus runtime
  scanning are the first-slice handoff);
- a workflow file, committed secret, or live deployment;
- automatic commit, push, checkout, fetch, reset, or history rewriting;
- merging, splitting, deleting, or reclassifying notes from a Git capture.
