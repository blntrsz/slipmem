# Approval and wiki services evidence

Status: **core approval and on-demand cited wiki implemented and tested.**
Date: 2026-11-17
Authority: [`docs/mvp-plan.md`](./mvp-plan.md) sections 8, 9, 12, 13.4,
13.5; [`docs/mvp-implementation-log.md`](./mvp-implementation-log.md) slices 3a,
4a, and 4b.

This document records the two additive core services, their integration API,
security behavior, verification, and the work that remains in the CLI, MCP,
server, and web surfaces. It does not modify the shared implementation log.

## 1. Scope and boundaries

Added:

- `packages/core/src/approval/**` - MCP write policy, filesystem proposal
  store, human review/apply/reject, diffs, expiry cleanup, base-hash checks.
- `packages/core/src/wiki/**` - bounded topic selection, extractive page
  assembly, structured/Markdown rendering, opt-in synthesized mode, safe local
  agent process, exact-support-span citation validator.
- `packages/core/src/index.ts` - additive exports for both modules.

Not edited: `packages/schemas/**`, `packages/core/src/markdown/**` (repository,
parser, index), `packages/cli/**`, `packages/migration/**` or
`packages/core/src/migration/**`, and the shared implementation log.

The services consume narrow structural slices of the existing repository rather
than reimplementing file mechanics:

- Approval: `Pick<MarkdownNoteRepositoryShape, "root" | "scan" | "get" |
  "create" | "update" | "delete">`.
- Wiki: `Pick<MarkdownNoteRepositoryShape, "root" | "scan">`.

Atomic writes, the repository lock, note validation, collision suffixes,
unknown-frontmatter preservation, and backup-on-delete stay in the repository.

## 2. Approval policy

`packages/core/src/approval/policy.ts` implements the frozen matrix.

| Caller | Operation | Default result |
| --- | --- | --- |
| human | any create/update/delete | direct |
| MCP | create/update fleeting | direct, `provenance.source: mcp` |
| MCP | create/update literature | direct, `provenance.source: mcp`, reference required |
| MCP | create permanent | pending proposal |
| MCP | update permanent | pending proposal |
| MCP | reclassify to permanent | pending proposal |
| MCP | reclassify from permanent | pending proposal |
| MCP | delete any type | pending proposal, even with the unsafe opt-in |

`SLIPMEM_MCP_WRITE_POLICY`:

- unset, empty, or `approval` -> safe default.
- `direct` -> `direct-unsafe`: bypasses pending for MCP permanent creates,
  updates, and reclassification only. Deletes remain pending.
- any other value -> fails closed to `approval` and returns a warning string.

An unsafe direct permanent write records `provenance.source: mcp-direct`
(an application-defined source value) plus the actor. Normal MCP writes record
`source: mcp`; approved proposal content carries the proposer's provenance.
`SLIPMEM_ACTOR` or a request actor is metadata, never authentication.

## 3. Proposal lifecycle

`packages/core/src/approval/proposal-store.ts` stores one strict JSON record per
proposal at:

```text
.slipmem/.state/pending/proposal-YYYYMMDDHHmmss-<8 hex>.json
```

Records use the shared `Markdown.ApprovalProposal` schema and are written with
the repository's atomic temp-file-plus-rename helper (mode `0600`).

Lifecycle:

1. `submitMcp` validates the request, reads the current target if
   any, applies the policy, and either writes directly through the repository or
   stores a proposal.
2. A pending result is exactly
   `{ status: "pending_approval", proposalId, summary }`. No note file changes.
3. Creates reserve a canonical note ID from the frozen filename helper, using
   existing files and other pending creates as the collision set.
4. Updates and reclassifications bind `baseHash` to the current whole-file
   SHA-256. Deletes bind the same hash and carry no replacement content.
5. A human calls `review()` to see summaries, diffs, current hash, stale and
   expired flags, and any tampered proposal files. `review()` cleans expired
   proposals by default and reports the removed IDs.
6. Applying revalidates:
   - proposal schema, ID shape, canonical direct-child path, and TTL limit;
   - expiry against the current clock;
   - create: target must not exist, proposed content must parse and carry the
     proposal ID, and the written note must keep that exact ID;
   - update/reclassify: current note must exist, `baseHash` must still match,
     proposed content must parse, ID must match, and `createdAt` must not change;
   - delete: current note must exist and `baseHash` must still match.
7. Only after the repository write succeeds is the proposal file removed.
8. `reject()` removes the proposal and changes no note.
9. Deletes continue to use the repository's backup move outside the note root.

Bounds and storage hardening:

- `DEFAULT_PROPOSAL_TTL_MS` = 7 days.
- `MAX_PENDING_PROPOSALS` = 200 active proposals per root.
- Proposal IDs must match `proposal-\d{14}-[0-9a-f]{8}`.
- Proposal `path` must equal the canonical note path for `noteId`.
- Expiry may not exceed the configured TTL from `createdAt`.
- Summary, actor, and content sizes are bounded; malformed or oversized files
  are reported by `review().invalid` and cannot be applied.
- Proposal files live under `.state/` and are never notes, index entries, or
  `.slipmem/*.md` files.

There is deliberately **no MCP approve/reject surface**. `submitMcp` only
writes directly or returns a pending ID. `review`, `apply`, and `reject` are
separate methods for local human interfaces and must not be registered as MCP
tools.

## 4. Approval integration API

```ts
import {
  ApprovalServiceLive,
  makeApprovalService,
  type McpWriteInput,
} from "@slipmem/core"
```

From the ambient repository layer:

```ts
const ApprovalCore = ApprovalServiceLive({
  actor: process.env.SLIPMEM_ACTOR,
  env: process.env, // SLIPMEM_MCP_WRITE_POLICY
})
```

Or construct directly from a repository value:

```ts
const approval = yield* makeApprovalService(repository, {
  actor: process.env.SLIPMEM_ACTOR,
  env: process.env,
})
```

MCP write path:

```ts
const result = yield* approval.submitMcp({
  operation: "create",
  type: "permanent",
  title: "Agent memory is bounded",
  content: "Every recall operation has a hard limit.",
  actor: process.env.SLIPMEM_ACTOR,
})
// { status: "pending_approval", proposalId, summary }
// or { status: "direct", note, unsafeDirect }
```

CLI/web review path:

```ts
const report = yield* approval.review()          // { proposals, invalid, removed }
const applied = yield* approval.apply(proposalId) // revalidates hash/rules
const rejected = yield* approval.reject(proposalId)
```

Each `review().proposals` item contains the strict `proposal`, `summary`,
`diff`, `stale`, `expired`, and `currentHash`. Diffs are bounded and render
proposal text as plain +/- lines, never as executable instructions.

## 5. Wiki selection and output

`packages/core/src/wiki/selection.ts`:

1. Normalize the display topic with the frozen shared slug pipeline. An empty
   slug is an error with an actionable message.
2. Use permanent and literature notes by default; fleeting notes require
   `includeFleeting: true`.
3. Rank exact `topics` membership first, then title, reference, and body
   matches. There is no semantic/vector ranking.
4. Default 10 notes, hard maximum 25; non-integer or out-of-range limits fail
   with `invalid-limit`.
5. When nothing matches, return zero notes/sections and bounded existing-topic
   suggestions. No content is invented.

`packages/core/src/wiki/render.ts`:

- Structured output is canonical: `topic`, `generatedAt`, `mode`, `noteCount`,
  `sources`, `sections`, and `markdown`.
- Extractive mode emits one block-quoted verbatim excerpt per note, with an
  adjacent `[[note-id]]` and file path citation. Conflicting notes remain in
  separate cited sections; they are never merged.
- Excerpts are cut at a sentence/word boundary and capped at 600 characters.
- Page Markdown is capped at 20,000 characters; structured sections are built
  within the same budget. No wiki page is written under `.slipmem/`.
- A note containing "ignore previous instructions" is emitted as quoted data.
  Nothing in the note is executed, interpreted as a path, or used as a shell
  command.

## 6. Synthesized mode

Configuration:

- `SLIPMEM_WIKI_SYNTHESIS` unset / empty / `extractive` -> extractive default.
- `SLIPMEM_WIKI_SYNTHESIS=agent` -> requires `SLIPMEM_WIKI_AGENT` (executable)
  and optional `SLIPMEM_WIKI_AGENT_ARGS` (a JSON array of strings).
- Any other value is treated as a model ID. It works only if the application
  registers an adapter for that exact ID. An unconfigured model ID fails with
  `synthesis-adapter-unsupported`; no provider or network default is assumed.

The local agent boundary (`packages/core/src/wiki/synthesis.ts`):

- `spawn(command, args, { shell: false })` with an explicit argv array.
- Note text is sent only as bounded JSON on stdin. It never appears in argv,
  environment variables, paths, or shell syntax.
- The payload is capped at 200,000 bytes; stdout at 1 MiB; runtime at 30 seconds
  by default.
- Note text is placed under `untrustedNotes` with a fixed instruction envelope;
  slipmem gives the process no tools or write access.
- A non-zero exit, timeout, unexpected output size, empty output, or invalid
  JSON fails with a bounded, actionable error. There is no silent fallback that
  pretends synthesis worked; the operator is told to use extractive mode or fix
  the configured command.

Citation validator:

- Top-level output must be JSON shaped as `{"sentences":[...]}`.
- Each item must have a bounded single-sentence `text`, a selected `noteId`,
  and a `quote` of at least 12 characters.
- The quote must be an exact substring of that note's body after collapsing
  whitespace.
- Unknown IDs, unsupported quotes, non-sentences, duplicates, and sentences
  beyond the 60-sentence cap are omitted, counted, and reported in the page
  footer. They are never rendered as claims.
- Every accepted sentence is followed by its own adjacent note ID and path.

## 7. Wiki integration API

```ts
import { WikiServiceLive, makeWikiService } from "@slipmem/core"

const Wiki = WikiServiceLive({
  now: Date.now,
  mode: "extractive",
  env: process.env, // SLIPMEM_WIKI_SYNTHESIS / AGENT / AGENT_ARGS
  // Optional explicit local adapters:
  modelAdapters: [{ modelId: "local-fixture-model", synthesize }],
})
```

Direct construction:

```ts
const wiki = yield* makeWikiService(repository, { env: process.env })
const page = yield* wiki.build({
  topic: "agent memory",
  limit: 10,
  mode: "extractive",
  includeFleeting: false,
})
```

`build()` returns `Markdown.WikiPage`; `select()` returns the normalized topic,
selected notes, and bounded suggestions for CLI/API use. `mode: "synthesized"`
requires a configured agent or adapter. `env` is read at build time so the
server can pass its own environment without mutating `process.env`.

## 8. Verification

Commands:

```text
bun test packages/core/src/approval   # 13 pass, 0 fail, 97 assertions
bun test packages/core/src/wiki       # 13 pass, 0 fail, 130 assertions
bun test packages/core               # 132 pass, 0 fail, 1168 assertions
bunx tsc --noEmit                     # no approval/wiki errors
bun run lint                          # no approval/wiki warnings or errors
```

Approval tests cover:

- the full policy matrix and fail-closed env parsing;
- permanent create pending -> review diff -> apply -> cross-read visibility;
- direct fleeting/literature writes with `source: mcp` and actor;
- permanent update and return/leave-permanent reclassification pending;
- rejection leaving notes unchanged;
- delete pending, no deletion before apply, backup after apply;
- stale update and stale delete refused without writing;
- expiry cleanup by review and refusal to apply an expired proposal;
- bounded proposal queue (`proposal-queue-full`);
- tampered/poisoned proposal files reported and never applied;
- hostile newline-heavy diffs bounded before LCS allocation;
- unsafe direct permanent writes recording `source: mcp-direct` while deletes
  still stay pending;
- proposals stored only under `.state/pending/`.

Wiki tests cover:

- topic-first selection, default exclusion of fleeting notes, explicit
  inclusion, fallback title match, and citations with `.slipmem/<file>` paths;
- empty topic with suggestions and no invented content;
- conflicting notes in separate cited sections;
- injection text quoted as data, unchanged note root, nothing executed;
- default 10 / max 25 limits and actionable over-limit errors;
- excerpt and total output bounds over 25 large notes;
- a real fixture child process producing one supported sentence while
  unsupported, unknown-note, and non-sentence claims are omitted;
- argv/stdin separation proving note text never enters process arguments;
- sentence-count and total-output bounds for synthesized mode;
- unregistered model ID fails closed; an explicitly registered adapter works;
- actionable missing-config, non-zero-exit, and malformed-JSON errors;
- agent config rejected unless args are a JSON string array.

## 9. Acceptance mapping

| Criterion | Core status | Evidence / remaining surface work |
| --- | --- | --- |
| APPROVE-01 | done | permanent create pending; no note file in test |
| APPROVE-02 | done | literature direct with `source: mcp` |
| APPROVE-03 | done | any delete pending; no file change before apply |
| APPROVE-04 | done at service | apply writes atomically through repository; CLI/web wiring pending |
| APPROVE-05 | done | reject leaves notes unchanged |
| APPROVE-06 | done | stale update/delete returns `stale-base` without writing |
| APPROVE-07 | done in API shape | no MCP apply method; server/MCP must not register one |
| APPROVE-08 | done | fleeting create/update direct with provenance |
| APPROVE-09 | done | proposals only under `.state/pending`; no note/index visibility |
| WIKI-01 | done | topic filters, default/max limits tested |
| WIKI-02 | done | every section/sentence has an adjacent ID/path citation |
| WIKI-03 | done | empty result and suggestions, no generated content |
| WIKI-04 | done | conflicting notes in separate cited sections |
| WIKI-05 | done | wiki tests assert an unchanged root |
| WIKI-06 | done | injection note quoted as data; agent receives stdin JSON only |
| WIKI-07 | done | fixture process + strict exact-span validator omits unsupported sentences |

## 10. Known limitations and integration notes

- Applying an update/reclassification uses `repository.update`, which stamps a
  fresh `updatedAt`. The applied file is therefore not byte-identical to the
  previewed content, but every proposed field was revalidated and the preview
  contains all semantic changes.
- A create proposal reserves its filename. If another writer takes that exact
  ID between proposal and approval, apply refuses with `stale-base`; the
  repository's suffixed note created during that race is moved to the normal
  backup location before the failure is returned. In the normal single-writer
  case no note is written for a stale create.
- Extractive excerpts are truncated to the excerpt bound; synthesized output is
  sentence-bounded. Both are explicit in the page footer when total output is
  cut.
- Synthesized mode is opt-in and local. The core does not ship a hosted model
  adapter and does not claim that any model ID works without registration.
- The MCP server, HTTP API, CLI, and web still need to consume these services.
  In particular, the MCP registration must call `submitMcp` and must never
  expose `review`, `apply`, or `reject` as tools.
- Proposal `actor` and note provenance are descriptive metadata, not
  authentication or authorization.

## 11. File map

- `packages/core/src/approval/errors.ts`
- `packages/core/src/approval/policy.ts`
- `packages/core/src/approval/proposal-store.ts`
- `packages/core/src/approval/diff.ts`
- `packages/core/src/approval/approval-service.ts`
- `packages/core/src/approval/approval.test.ts`
- `packages/core/src/wiki/errors.ts`
- `packages/core/src/wiki/selection.ts`
- `packages/core/src/wiki/render.ts`
- `packages/core/src/wiki/synthesis.ts`
- `packages/core/src/wiki/wiki-service.ts`
- `packages/core/src/wiki/wiki.test.ts`
- `packages/core/src/wiki/fixtures/synthesis-agent.mjs`
- `packages/core/src/index.ts` (additive exports)
