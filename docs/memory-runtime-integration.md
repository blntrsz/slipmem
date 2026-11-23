# Memory runtime integration contract

Status: implementation note for agents touching automatic memory, capture, or
the HTTP/stdio serve paths, 2026-11-22. The authoritative behavior is in
`packages/mcp/src/automatic-memory.ts` and its tests.

## Primary chat model

Serving modes require a primary chat model. The stdio entry point, the HTTP
`/mcp` endpoint, the web server, and the background `slipmem service` process
resolve it unconditionally; startup fails closed if it is missing or partial.
`SLIPMEM_AUTO_MEMORY` and its interval or run-on-start variables are no longer
read. Ordinary one-shot CLI commands do not resolve or require a model. Tests and embedding hosts may inject an explicit
`AutomaticMemoryRuntime`, including `{ enabled: false }`.

Canonical environment names:

| Purpose | Variable |
| --- | --- |
| Provider selector | `SLIPMEM_CHAT_PROVIDER=openai-compatible` |
| Base URL | `SLIPMEM_CHAT_BASE_URL` |
| Model | `SLIPMEM_CHAT_MODEL` |
| Optional bearer token | `SLIPMEM_CHAT_API_KEY` |

The legacy `SLIPMEM_MAINTENANCE_PROVIDER`, `SLIPMEM_MAINTENANCE_BASE_URL`,
`SLIPMEM_MAINTENANCE_MODEL`, and `SLIPMEM_MAINTENANCE_API_KEY` names remain
accepted as aliases. There is no default provider, URL, model, or key.

Reusable getter for capture/extraction code:

```ts
import { resolvePrimaryChatModel } from "@slipmem/mcp"

const chat = resolvePrimaryChatModel(env) // undefined when nothing is configured
if (chat !== undefined) {
  // chat.chat({ messages }) -> Effect<{ content: string }, ModelTransportError>
  // chat.model, chat.label, chat.egress
}
```

`resolvePrimaryChatModel` only constructs a bounded, tool-less
OpenAI-compatible transport; it performs no request until `chat.chat` is
called. `slipmem capture git` has separate optional `SLIPMEM_CAPTURE_*`
overrides and otherwise inherits this primary chat configuration. Capture code
can pass `SLIPMEM_CHAT_*` through and call the getter from a package that
depends on `@slipmem/mcp`, or copy the resolved values through an explicit
adapter. Do not add a package dependency solely for this.

## Prompt recall

- `SLIPMEM_RECALL_PROVIDER=jev` plus `TYPESAFE_API_KEY` selects Jev.
- With Jev off/unset, the same primary chat model is the evaluator. It returns
  one validated JSON decision per note (`{"verdict":"relevant"|"irrelevant",
  "confidence"?: 0..1}`); malformed output is a typed per-note `invalid-output`
  failure.
- There is no runtime fallback after a provider is selected. A configured
  provider's transport/HTTP/output error is reported for that note and is never
  retried against another model or a keyword heuristic.
- No primary model and no Jev means `recall_prompt` fails closed with
  `evaluator-not-configured`.

## Wake path and durable receipts

There is no normal periodic timer. A scoped `Effect` queue receives:

- one startup recovery wake;
- an in-process wake from the wrapped repository after a successful `create`,
  `update`, or `delete` of a fleeting or literature note;
- a cross-process wake hint from a scoped `fs.watch` on the note root.

The watcher ignores `.state/`, hidden/atomic-temporary names, nested paths, and
non-`.md` files. A watcher startup failure is reported on stderr; in-process
wakes and the next startup recovery still work. If directory watching is not
supported in an environment, the supported cross-process boundary is
"restart for recovery, or run capture through the MCP/web process". In-process
HTTP capture can inject the exported `RawWriteSignal` service or use
`makeRawWriteRepositoryLayer` so it emits the same wake.

After each successful bounded batch, `.state/automatic-memory-revisions.json`
records a deterministic map of the raw source revisions that batch actually
offered to the provider, plus the post-run managed-permanent ID/hash set. An
explicit no-op that scanned the inbox and found every raw revision already
consumed records the current source snapshot instead. A restart or a touch-only
watch event skips the provider only when every current source revision is
covered by an examined receipt and the managed set is unchanged. A new revision
hash, an unexamined source, a missing/corrupt receipt file, or a
deleted/restored managed permanent causes another pass.

One wake drains bounded worker batches rather than stopping after the first
source limit. It continues while the current inbox still has unexamined
revisions and the previous batch recorded at least one new examined revision;
it stops when every current revision is covered or no progress is possible. An
unexamined backlog revision is never receipted and therefore stays pending
across a restart. The safety bound for a single wake is 1,000 batches, and each
batch is itself bounded by the worker's source limit. A pass that refused a
repository write or could not offer pending sources writes no receipt for that
batch and remains retryable. Receipts written by the earlier whole-snapshot
implementation do not carry the `coverage: "examined"` marker; they are treated
as missing and get one conservative rescan. The file name and `revisions` shape
are part of the acceptance test.

The worker's `MaintenanceRunResult` exposes `examinedSources` (ID plus the exact
content hash offered to the provider) for this receipt path. Orchestrators must
use it instead of a repository snapshot taken outside `run()`, because a
bounded run deliberately leaves the rest of the backlog unexamined.

Runs are serialized by a separate cross-process lease at
`.state/automatic-memory.lease`. The lease is held across the provider call but
the repository mutation lock is not: each write still takes the repository lock
only for its own critical section. A concurrent consolidation waits for the
lease and then re-checks the durable receipts, so it normally becomes a no-op
rather than a duplicate model call.

## Coordination pointers

- `packages/mcp/src/layer.ts` wraps the shared repository and provides the same
  wrapped graph to tools and the worker.
- `MaintenanceRunResult.examinedSources` is the worker-to-lifecycle handoff for
  receipts. Do not replace it with a repository scan taken outside `run()`: that
  is the whole-snapshot bug that made backlogs larger than the source limit
  terminal.
- `packages/mcp/src/automatic-memory.test.ts` includes the 13-note bounded-batch
  drain regression and the partial-receipt/unexamined-revision regression.
- `packages/server/src/git-ingress.ts` imports `PRIMARY_CHAT_ENV_NAMES`,
  falls back from `SLIPMEM_CAPTURE_*` to the shared chat names, and lets the
  note-root watcher drain captured sources in the same serve process.
- `packages/mcp/src/automatic-memory.acceptance.test.ts` drives the real stdio
  entrypoint for trigger, recall, receipt, and restart behavior.
- `scripts/automatic-memory-e2e.ts` still documents older interval-based env
  names; the runtime ignores `SLIPMEM_AUTO_MEMORY_INTERVAL_MS` and
  `SLIPMEM_AUTO_MEMORY_RUN_ON_START` now.
