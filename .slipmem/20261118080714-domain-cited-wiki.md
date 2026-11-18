---
schema: 1
id: 20261118080714-domain-cited-wiki
type: permanent
title: "Domain: cited wiki"
createdAt: "2026-11-18T08:07:14Z"
updatedAt: "2026-11-18T08:07:14Z"
tags:
  - domain
  - wiki
provenance:
  source: cli
  actor: user
---

The cited wiki is generated on demand and read-only; pages are not persisted as notes. `--out` must be outside the note root. Selection normalizes the requested tag and, by default, considers permanent and literature notes; fleeting notes need explicit opt-in. Exact tag membership outranks title, reference, then body matches, with newest `updatedAt` and ID as tie-breakers. Limits are 1-25, default 10; when nothing matches, up to 10 existing tag suggestions are returned.

Extractive mode is always available. It quotes each selected note verbatim, one cited section per note, with a bounded excerpt and a citation path of root basename plus filename. Conflicting notes stay separate. Output is bounded; whole trailing sections are dropped rather than slicing a section or citation.

Synthesized mode is opt-in and needs a configured local model adapter for the exact model ID or a configured agent process. The agent receives bounded note JSON, runs without a shell, is normally sandboxed, and must return sentences with an exact supporting quote. Unsupported sentences are dropped; a page with none renders an explicit empty result. Synthesized prose is not a second source of truth.

Evidence: [selection.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/selection.ts), [render.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/render.ts), [wiki-service.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/wiki-service.ts), [synthesis.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/synthesis.ts), [wiki command](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/wiki.ts).

Related: [.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md](20261118022816-the-local-trust-boundary-is-not-authentication.md), [.slipmem/20261118022814-architecture-one-repository-three-surfaces.md](20261118022814-architecture-one-repository-three-surfaces.md).
