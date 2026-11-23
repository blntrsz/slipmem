# Automatic memory and separate wiki: public inspirations

Status: **design note with one implemented serving slice**, 2026-11-22. This
document records public inspiration for automatic repository memory and a
separate, agent-maintained wiki, then separates the narrow slice that exists in
this tree from future design. It is not an operator guide, and it is not
evidence of a live rollout or an automated harness or repository hook. Setup
belongs in the
[operator guide](operator-guide.md#memory-runtime-and-queue-driven-consolidation);
current behavior belongs there and in the implementation.

Sources were read on 2026-11-22. Only the public pages below are summarized; no
non-public Greptile behavior is inferred.

## Sources

| Influence | Public source |
| --- | --- |
| Repository knowledge base | [Greptile: Knowledge Base](https://www.greptile.com/docs/how-greptile-works/knowledge-bases) |
| Learned preferences | [Greptile: Memory and Learning](https://www.greptile.com/docs/how-greptile-works/memory-and-learning) |
| Codebase relationships | [Greptile: Graph-based Codebase Context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context.md) |
| Separate LLM wiki | [Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) |

## Current implemented first slice

The slice in this tree is narrower than the designs below. It has no default
provider and runs only in a long-lived MCP serve process that has an explicit
primary chat model. One-shot CLI commands do not start it, and it is not a Git
hook, CI job, or agent-harness callback. Setup and exact limits are in the
[operator guide](operator-guide.md#memory-runtime-and-queue-driven-consolidation).

### Tool-less chat worker

Serving requires an explicit OpenAI-compatible primary chat model, model ID, and
base URL. Queue-driven passes run at startup and after a raw note revision;
there is no periodic timer. The worker sends one bounded,
tool-less request per pass. It selects bounded fleeting or literature source
notes plus existing maintenance-owned permanent candidates, and it never edits
the source notes. Writes are generated-only: it may create a permanent or
update a permanent whose maintenance marker still matches, and it never
deletes, reclassifies, or rewrites a note whose managed fields were edited by
hand. It writes directly with provenance `maintenance`, not through the MCP
approval queue. A failed pass is reported and the next wake is attempted.

### Source version IDs and hashes

Each generated permanent records its source revisions under `maintenance`: the
source note ID plus a SHA-256 hash of the whole source file when it was
consolidated. That ID-and-hash pair, not wall-clock age, decides whether a
revision is pending. Before writing, the worker re-reads the selected sources
and refuses an operation if a source hash changed or the source disappeared. A
generated note also records `generatedAt` and a `stateHash` over the managed
title, body, tags, and source set; a later manual edit changes that hash and
makes the note ineligible for automatic update. These are note-local revision
hashes, not a compiled repository catalog or an immutable section-version
service.

### Read-only prompt retrieval

`recall_prompt` is a read-only MCP tool. Jev/TypeSafe is selected by
`SLIPMEM_RECALL_PROVIDER=jev` plus `TYPESAFE_API_KEY`; without it, the same
required primary chat model makes one structured decision per note. It is
read-only with respect to local storage: it evaluates eligible permanent notes
against one prompt and returns bounded summaries plus explicit per-note
failures. It sends each note's ID, title, body, tags, and `updatedAt` to exactly
one configured provider at a time, offers no tools, does not repair output or
fall back to keywords, and runs no background recall. A configured provider's
failure is reported per note and never silently retried against another
provider.

No compiled catalog, incident or revert collection, scoped-rule learning,
semantic conflict lint, merge/split path, or separate wiki exists in this
slice.

## Greptile knowledge bases

Greptile describes a knowledge base as a living set of repository docs that is
read on every review and can be read and edited by the team. It has three
visible parts:

- An index: an architecture overview, a glossary, and a map of where files
  live.
- Per-area docs: one for each significant module and end-to-end flow, covering
  purpose, connections, risk areas, and key files.
- A reverts section: past high-signal revert, rollback, and incident PRs that
  are present in the repository.

The public description says the knowledge base is built once by scanning the
repository and then kept in sync as the code changes. The overview does not
prescribe internal storage; the MCP tools describe versioned Markdown and report
immutable section version IDs, though document reads always follow the current
version. The useful design claim is narrower: repository understanding is a
maintained artifact, not a one-off prompt, and it should refresh when the
repository moves.

Greptile also exposes the knowledge base to editors over MCP through four
read-only tools: list knowledge bases, list documents, get a document, and
search. The public page explicitly marks returned documents as untrusted
evidence (`untrustedContent: true` plus a notice) and warns that anyone who can
land a commit can influence the text. For Slipmem, the analogous design is a
read-only MCP view that returns derived text with provenance and explicit
untrusted markers, never as instructions, permissions, or a substitute for the
raw note.

## Greptile memory and learning

Greptile learns from team comments on pull requests, replies to its suggestions,
and reactions. It uses addressed-versus-ignored comments to tune how much minor
feedback it gives, and it infers rules that are conditional on context. Its
examples make the conditionality explicit: a length rule may apply in one layer
but not another.

The important separation is between the feedback event and the learned
preference. A comment is evidence about one change; a preference is a
generalization that may apply later. Slipmem should keep those apart. A learned
preference should be reviewable, carry its scope and applicability, and never
silently become a global rule. Scope identifies where it belongs; applicability
states the conditions under which it should be recalled or ignored.

"Learning nitpickiness" is a useful goal for a review bot, not a universal
target for a memory system. The transferable idea is to learn what context
matters, not to optimize for acceptance of generated comments.

## Greptile graph context

Greptile builds a graph of files, functions, calls, imports, variables, and
usage sites, then queries it when reviewing a change. The public description
uses it to find dependencies, callers, impact, and similar patterns elsewhere
in the codebase.

For Slipmem, this argues for organizing derived repository docs around modules
and flows rather than around arbitrary file summaries, and for linking a page
to the code it describes. The graph is a context and retrieval mechanism, not
memory by itself. Graph-derived context still needs a source revision and a
refresh path to be trustworthy.

## Karpathy's LLM Wiki

Karpathy describes a persistent wiki built by an agent between the reader and a
collection of raw sources. Its public pattern has three layers:

- Raw sources, which the agent reads but never modifies.
- The wiki, a directory of agent-generated markdown pages that the agent
  creates, updates, and cross-references.
- A schema document that records structure, conventions, and workflows.

The operations are ingest, query, and lint. Ingest reads one source, discusses
it, writes a summary, updates the index and affected pages, and appends to a
log. Query answers from the wiki; useful answers can be filed back as new
pages. Lint looks for contradictions, stale claims, orphan pages, missing
cross-references, and gaps.

Two navigation files have different jobs: `index.md` is a content catalog,
while `log.md` is a chronological, append-only record of ingests, queries, and
lint passes. The gist is intentionally abstract; it does not define a provenance
or verification contract tying a synthesized claim to a specific, checkable
source version. Its citations show where an answer came from, not that the page
is correct.

## Future design beyond the first slice

The public patterns point past the current serving worker. None of the following is
implemented by that worker or by `recall_prompt`; these are design intent.

- **A separate, agent-maintained wiki and compiled catalog.** Raw notes and
  repository sources stay untouched; a wiki is a projection that reads them
  and never rewrites, moves, or deletes them. An index, module docs, and flow
  docs would be compiled from a pinned repository revision and refreshed
  together. The catalog would be disposable and rebuildable, not a second
  source of truth. The first slice generates individual permanents and has no
  repository-wide catalog.
- **Incident and revert links.** A derived reverts or incident collection
  would summarize high-signal rollback and incident changes already present in
  the repository. It would be provenance-bearing derived context, not a
  promoted source note, and removing the layer would leave the source set
  intact.
- **Scoped rules.** Learned preferences would stay separate from the feedback
  event that produced them and carry both scope (where they belong) and
  applicability (when they should be recalled or ignored). They would be
  reviewable and would never silently become global instructions. The first
  slice has no preference-learning path.
- **Semantic conflict lint.** A separate lint pass would report
  contradictions, stale source references, orphan pages, broken
  cross-references, and gaps. It would not edit notes, resolve conflicts by
  rewriting unrelated pages, or promote a synthesized claim to verified
  knowledge. Conflict and stale-source checks are future design, not current
  guarantees.
- **Merge and split.** Each ingest or refresh would make a small, explainable
  decision for one note or page: create, update, merge, split, or leave
  unchanged. The current worker only creates or updates whole generated
  permanents; it does not merge or split notes.
- **Versioned derived memory.** An index plus module and flow docs would point
  at the repository revision they were built from. Freshness would compare
  against that pin, not wall-clock age, and a reference that can no longer be
  rechecked would be visible as stale rather than silently current. The
  current slice pins source note revisions by ID and hash; it does not version
  a repository-derived catalog.
- **A read-only derived MCP view.** Derived pages would be returned with
  provenance and explicit untrusted markers, never as instructions,
  permissions, or verified note truth. Current `recall_prompt` retrieval is
  read-only but is not a page or catalog view.

## Design versus shipped

| Statement in this document | Status |
| --- | --- |
| Summaries of the four public sources | Public description, read 2026-11-22 |
| Tool-less maintenance worker, queue-driven passes, generated-only writes, and source ID/hash tracking | Implemented in this tree; serving requires an explicit primary chat model; see the [operator guide](operator-guide.md#memory-runtime-and-queue-driven-consolidation) |
| Read-only `recall_prompt` through optional Jev/TypeSafe or the required primary chat model | Implemented in this tree; see the [operator guide](operator-guide.md#prompt-recall-optional-jev-required-model) |
| Compiled catalog, incident/revert links, scoped rules, semantic conflict lint, merge/split, or a separate wiki | Future design only |
| Live rollout or automated harness or repository hook | Not claimed |

Nothing in this document becomes shipped behavior by appearing here. Treat the
current implementation and operator documentation as authoritative for what
exists, and treat this page as a record of public inspiration and design
boundaries.
