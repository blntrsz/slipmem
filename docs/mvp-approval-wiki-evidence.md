# Approval and wiki services evidence

Status: **core approval and on-demand cited wiki implemented and tested,
including compare-and-swap approval apply, conservative full-paragraph
extractive citation validation, and a fail-closed agent sandbox policy.**
Date: 2026-11-18
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
  agent process, exact full-paragraph support citation validator.
- `packages/core/src/index.ts` - additive exports for both modules.
- `packages/core/src/markdown/repository.ts` and `errors.ts` - an optional
  `expectedContentHash` compare-and-swap guard on update and delete, checked
  under the existing repository lock, plus the `stale-base` error code.

Not edited: `packages/schemas/**`, the parser/index files under
`packages/core/src/markdown/` other than those two files, `packages/cli/**`,
`packages/migration/**` or `packages/core/src/migration/**`, and the shared
implementation log.

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
   proposals by default, reports the removed IDs, and quarantines old malformed
   files under bounded local state.
6. Applying revalidates:
   - proposal schema, ID shape, canonical direct-child path, and TTL limit;
   - expiry against the current clock, and a future-skew guard on `createdAt`;
   - create: target must not exist, proposed content must parse and carry the
     proposal ID, and the written note must keep that exact ID;
   - update/reclassify: current note must exist, proposed content must parse,
     ID must match, and `createdAt` must not change;
   - delete: current note must exist.
7. Updates and deletes pass `baseHash` to the repository as a
   compare-and-swap guard. The repository re-reads the note and compares its
   whole-file SHA-256 **inside `withRepositoryLock`**, immediately before the
   write or backup move. The earlier `apply` read is only a fast, descriptive
   check; the under-lock comparison is authoritative and closes the
   review/apply interleaving race.
8. Only after the repository write succeeds is the proposal file removed.
9. `reject()` removes the proposal and changes no note.
10. Deletes continue to use the repository's backup move outside the note root.

Bounds and storage hardening:

- `DEFAULT_PROPOSAL_TTL_MS` = 7 days.
- `MAX_PENDING_PROPOSALS` = 200 active proposals per root.
- Proposal IDs must match `proposal-\d{14}-[0-9a-f]{8}`.
- Proposal `path` must equal the canonical note path for `noteId`.
- Expiry may not exceed the configured TTL from `createdAt`, and may not be
  more than one TTL ahead of the current clock.
- A hand-edited `createdAt` more than five minutes ahead of the current clock is
  rejected, so a future timestamp cannot make a proposal immortal.
- Summary, actor, and content sizes are bounded; malformed or oversized files
  are reported by `review().invalid` and cannot be applied.
- Old malformed files (mtime older than the TTL) are moved to
  `.state/quarantine/pending/`, at most 20 per cleanup run. That directory keeps
  at most 100 records; the oldest are removed beyond the cap. Fresh malformed
  files stay visible in `review().invalid` rather than being silently deleted.
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
`review()` also returns `quarantined` filenames moved by that run.

Repository compare-and-swap API for integration:

```ts
repository.update({ ...input, expectedContentHash: baseHash })
repository.delete(id, { expectedContentHash: baseHash })
```

`expectedContentHash` is optional, so ordinary human/CLI writes are unchanged.
When present and stale, the repository fails with
`MarkdownError { area: "repository", code: "stale-base" }` and writes nothing.
The approval service maps that code to `ApprovalError { code: "stale-base" }`.
Callers that need optimistic concurrency should pass the hash they observed and
retry from a fresh read, never retry blindly with the old hash.

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
- Page Markdown is capped at 20,000 characters, and the complete serialized
  structured page is capped at 40,000 characters. Headings are capped at 120,
  source titles at 200, and citation paths at 300 characters. Bounds apply to
  the structured result as well as Markdown, so a huge note title cannot evade
  the page bound through `sources[]`.
- Bounding drops whole trailing sections and any source that no longer has a
  citing section. It never slices a section or a citation partway. The fallback
  Markdown truncator cuts at a line boundary and drops an incomplete trailing
  citation line, so every emitted `Source: [[id]] (`path`)` citation is closed
  and addressable.
- No wiki page is written under `.slipmem/`.
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

The local agent boundary (`packages/core/src/wiki/synthesis.ts` and
`sandbox.ts`):

- `spawn(command, args, { shell: false })` with an explicit argv array.
- Note text is sent only as bounded JSON on stdin. It never appears in argv,
  environment variables, paths, or shell syntax.
- The payload is capped at 200,000 bytes; stdout at 1 MiB; runtime at 30 seconds
  by default.
- The child receives only an allowlist of environment variables (`PATH`, `HOME`,
  `TMPDIR`, locale, terminal hints). Unrelated process secrets such as API keys
  are not inherited.
- **Sandbox policy:** by default the process must run under a working bubblewrap
  sandbox (`--unshare-all`, read-only root, fresh writable `/tmp`, cleared
  environment, note root hidden when it does not contain the executable).
  bubblewrap is *probed*, not merely located: in containers where user
  namespaces are unavailable the probe fails and the agent is refused.
- If no working sandbox is available, the agent fails closed with
  `synthesis-config`. The documented unsafe escape hatch is
  `SLIPMEM_WIKI_AGENT_UNSAFE=1` (or `allowUnsandboxedAgent: true` in core).
  With that opt-in the process runs directly with the slipmem user's full
  filesystem privileges. It is not confined, and the documentation says so.
  This is never a claim that an arbitrary agent has no tools or write access.
- Even inside the sandbox, the read-only root leaves other world-readable files
  visible. The sandbox is a write, network, note-root, and environment boundary,
  not a confidentiality boundary.
- A non-zero exit, timeout, unexpected output size, empty output, or invalid
  JSON fails with a bounded, actionable error. There is no silent fallback that
  pretends synthesis worked; the operator is told to use extractive mode or fix
  the configured command.

Citation validator:

- Top-level output must be JSON shaped as `{"sentences":[...]}`. The field name
  is retained for adapter compatibility; each entry is now a citation item, not
  necessarily one sentence.
- Each item must have a bounded `text`, a selected `noteId`, and a `quote` of at
  least 12 characters. An item may contain several source sentences only because
  its `text` and `quote` are the **whole source paragraph/block**; the 500
  character item bound still applies.
- The `quote` must be an **exact complete source paragraph or block** from that
  note body after normalizing line wrapping, whitespace shape, wrapping
  quotation marks, and Markdown block markers. Markdown headings, list items,
  blockquotes, and task markers are handled; fenced code is excluded; wrapped
  source lines are joined. There is no sentence segmentation: an individual
  sentence inside a multi-sentence paragraph is not a valid span, even when it
  ends in terminal punctuation and is a real substring.
- Punctuation is never stripped. `"Deleting is safe..."` does not equal
  `"Deleting is safe."`, and a missing or added terminal period is a mismatch.
  Clips at an ellipsis, spaced ellipsis, parenthetical period/question/exclamation,
  or an abbreviation such as `Corp.`, `Co.`, or `et al.` are rejected because the
  quote is shorter than the source block, not because the validator guessed a
  sentence boundary. This is a fail-closed simplification: no heuristic sentence
  parser decides where a claim may stop.
- The `text` must equal the **full supplied quote** after the same conservative
  normalization (line wrapping, whitespace, wrapping quotation marks). A
  paraphrase or any different wording is omitted even when the quote is a real
  source block.
- The validator verifies exact extraction and full-block provenance, not
  semantic entailment. A paraphrase, negation, or opposite claim is omitted even
  when a nearby real source block exists. Accepted output displays the verbatim
  complete source paragraph, never a synthesized sentence or clipped excerpt.
- Unknown IDs, unsupported or clipped quotes, non-extractive text, duplicates,
  and items beyond the 60-item cap are omitted, counted, and reported in the page
  footer. They are never rendered as claims.
- Every accepted item is followed by its own adjacent note ID and path.
- An empty synthesizer result says that no supported synthesized output was
  produced; it never claims that no notes matched when notes did match.

The payload sent to a local agent states the same contract: copy one complete
Markdown paragraph or block into both `text` and `quote`, preserve ellipses,
spaced ellipses, parentheses, abbreviations, and terminal punctuation exactly,
and omit anything that cannot be copied whole.

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
bun test packages/core/src/approval   # 17 pass, 0 fail, 119 assertions
bun test packages/core/src/wiki       # 29 pass, 0 fail, 186 assertions
bun test packages/core/src             # 198 pass, 0 fail, 1534 assertions
bun test packages/cli/src/wiki.test.ts packages/server/src
bunx tsc --noEmit                     # no approval/wiki/repository errors
bun run lint                          # no approval/wiki/repository warnings or errors
```

Approval tests cover:

- the full policy matrix and fail-closed env parsing;
- permanent create pending -> review diff -> apply -> cross-read visibility;
- direct fleeting/literature writes with `source: mcp` and actor;
- permanent update and return/leave-permanent reclassification pending;
- rejection leaving notes unchanged;
- delete pending, no deletion before apply, backup after apply;
- stale update and stale delete refused without writing;
- **interleaving regression:** a wrapper injects a concurrent repository write
  immediately before an approved update and before an approved delete. The
  pre-check has already passed, and the under-lock CAS still fails with
  `stale-base`, leaving the newer note intact and the proposal pending;
- future-dated `createdAt` and expiry beyond `now + TTL` rejected and never
  applied;
- expiry cleanup by review and refusal to apply an expired proposal;
- old malformed proposal files quarantined under `.state/quarantine/pending/`,
  with bounded per-run work and a capped retention set;
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
- structured-field and serialized-page bounds with a 30,000-character title;
  every emitted citation line remains complete;
- a real fixture child process producing one exact extractive paragraph while an
  opposite claim, unsupported quote, unknown-note claim, and mismatched text are
  omitted;
- **opposite-claim regression:** `"Caching is dangerous"` paired with the real
  span `"Caching is not dangerous"` is omitted and never rendered;
- **clipped-negation regression:** `text` and `quote` both set to
  `"dangerous for this workload."` are omitted for the body paragraph
  `"Caching is not dangerous for this workload."`, because the quote is not a
  complete source block;
- **clipped-qualifier regression:** `"Deleting is safe."` / `"Deleting is safe"`
  are omitted for `"Deleting is safe only after a verified backup."`, while the
  complete list items in the same Markdown body are accepted and cited;
- **ellipsis regressions:** `"Deleting is safe."` is omitted for
  `"Deleting is safe... only after verified backup."` and for the spaced form
  `"Deleting is safe . . . only after verified backup."`; a negated-source tail
  `"dangerous for this workload."` is also omitted from
  `"Caching is not... dangerous for this workload."`;
- **parenthetical punctuation regressions:** clips ending at an internal
  period, question mark, or exclamation inside parentheses are omitted when the
  paragraph continues after the closing parenthesis;
- **abbreviation regressions:** clips ending at `Corp.`, `Co.`, or `et al.` are
  omitted when more of the source paragraph follows;
- **multi-sentence paragraph regression:** a single sentence extracted from a
  two-sentence paragraph is omitted, while the exact whole paragraph is accepted
  as one item;
- Markdown-aware block reading accepts complete paragraphs after headings, list
  items, and wrapped lines; list items are separate blocks and fenced code is
  excluded;
- exact normalization accepts a complete quoted exact paragraph and rejects a
  version that differs only by terminal punctuation; a paraphrase with the same
  source block is omitted;
- empty synthesizer output says no supported synthesized output was produced,
  not that no notes matched;
- argv/stdin separation proving note text never enters process arguments;
- item-count, per-item character, and total-output bounds for synthesized mode;
- unregistered model ID fails closed; an explicitly registered adapter works;
- unsandboxed agent refused without the explicit unsafe opt-in; bubblewrap
  invocation and secret-free environment allowlist verified;
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
| APPROVE-06 | done | stale update/delete returns `stale-base`; repository CAS rechecks under lock |
| APPROVE-07 | done in API shape | no MCP apply method; server/MCP must not register one |
| APPROVE-08 | done | fleeting create/update direct with provenance |
| APPROVE-09 | done | proposals only under `.state/pending`; no note/index visibility |
| WIKI-01 | done | topic filters, default/max limits tested |
| WIKI-02 | done | every section/sentence has an adjacent ID/path citation; truncation never cuts one |
| WIKI-03 | done | empty result and suggestions, no generated content |
| WIKI-04 | done | conflicting notes in separate cited sections |
| WIKI-05 | done | wiki tests assert an unchanged root |
| WIKI-06 | done | injection note quoted as data; agent receives stdin JSON only |
| WIKI-07 | done | fixture process + strict full-paragraph extractive validator rejects paraphrases, opposite claims, and matched text+quote fragments clipped from negated, qualified, ellipsis, parenthetical, or abbreviation paragraphs; unsandboxed agents fail closed |

## 10. Known limitations and integration notes

- Applying an update/reclassification uses `repository.update`, which stamps a
  fresh `updatedAt`. The applied file is therefore not byte-identical to the
  previewed content, but every proposed field was revalidated and the preview
  contains all semantic changes.
- The under-lock CAS protects same-process and cooperating writers. It does not
  turn the filesystem into a multi-writer transaction: a non-cooperating process
  that ignores the repository lock can still race, and the MVP promises
  last-writer-wins for that cross-process case. Approval apply itself always
  uses CAS, so it cannot silently overwrite a repository-mediated edit.
- A create proposal reserves its filename. If another writer takes that exact
  ID between proposal and approval, apply refuses with `stale-base`; the
  repository's suffixed note created during that race is moved to the normal
  backup location before the failure is returned. In the normal single-writer
  case no note is written for a stale create.
- Extractive excerpts are truncated to the excerpt bound; synthesized items are
  bounded by count and characters. Both are explicit in the page footer when
  total output is cut.
- Synthesized mode is opt-in and local. The core does not ship a hosted model
  adapter and does not claim that any model ID works without registration.
- Validation is exact full-paragraph extractive-support checking, not semantic
  entailment or factual verification. It cannot prove that a source paragraph is
  true, current, representative, or relevant, and it rejects paraphrases. A
  passing item means only that `text` is a complete verbatim paragraph/block from
  the cited body with the same punctuation. It does **not** mean the paragraph is
  a precise answer, balanced, or free of misleading context when read alone.
  Operators who want prose synthesis must accept that unsupported items are
  omitted; extractive mode remains the fully cited fallback.
- There is deliberately no sentence splitter. Markdown headings, list items,
  blockquotes, and task markers are handled, wrapped lines are joined, and code
  fences are excluded, but the smallest citable unit is the whole block. A
  paragraph with several sentences must be quoted in full; if it exceeds the
  500-character item bound, the item is omitted. A note whose structure is not
  recognized as a block may be refused; the fallback is to cite the whole
  paragraph, restructure the note, or read it directly. This limitation is
  intentional: guessing sentence boundaries is how qualifiers and negations get
  clipped.
- CLI, server, MCP, and web surfaces must describe synthesized output as
  extractive citation validation ("verify sources"), never as semantic
  verification or truth. No UI may promise that a passing paragraph is correct or
  that the synthesizer understood the note; the guarantee is only complete
  verbatim citation.
- A bubbling sandbox that passes the probe still leaves world-readable host
  files visible through the read-only root. This is an integrity, network, and
  environment boundary, not a full confidentiality sandbox. When no sandbox
  works, the default is refusal; the unsafe opt-in is documented and must not be
  represented as confinement.
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
- `packages/core/src/wiki/sandbox.ts`
- `packages/core/src/wiki/synthesis.ts`
- `packages/core/src/wiki/synthesis.test.ts`
- `packages/core/src/wiki/wiki-service.ts`
- `packages/core/src/wiki/wiki.test.ts`
- `packages/core/src/wiki/fixtures/synthesis-agent.mjs`
- `packages/core/src/index.ts` (additive exports)
