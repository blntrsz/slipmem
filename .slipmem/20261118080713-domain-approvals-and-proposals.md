---
schema: 1
id: 20261118080713-domain-approvals-and-proposals
type: permanent
title: "Domain: approvals and proposals"
createdAt: "2026-11-18T08:07:13Z"
updatedAt: "2026-11-18T08:07:13Z"
tags:
  - domain
  - approval
  - security
provenance:
  source: cli
  actor: user
---

The approval service separates human writes from agent writes. Humans write directly. MCP fleeting and literature create/update are direct; MCP permanent create/update and reclassification to or from permanent are pending; MCP delete is always pending. `SLIPMEM_MCP_WRITE_POLICY=direct` means `direct-unsafe`: it skips pending only for permanent create/update/reclassify, never delete, and stamps `provenance.source: mcp-direct`.

Pending proposals are local state, never notes: one JSON file per proposal under `.slipmem/.state/pending/`, named `proposal-<14-digit UTC>-<8 hex>.json`. A proposal records its note ID, canonical path, operation, timestamps, summary, actor, and base hash. Defaults: 7-day TTL, 200 active proposals, 1000-character summary, 200-character actor, 1 MiB content, and a 5-minute future-skew limit.

`review` reports summaries, diffs, and staleness. `approve` revalidates expiry, canonical path, base hash, and note rules before an atomic write; create proposals also require the target not to exist. A failed derived-index refresh is reported as a warning, not a rollback. `reject` removes only the proposal. Review, approve, and reject are human-only and never MCP tools. `SLIPMEM_ACTOR` is provenance, not authentication.

Evidence: [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts), [approval-service.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/approval-service.ts), [proposal-store.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/proposal-store.ts), [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts).

Related: [.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md](20261118022816-the-local-trust-boundary-is-not-authentication.md), [.slipmem/20261118022814-architecture-one-repository-three-surfaces.md](20261118022814-architecture-one-repository-three-surfaces.md).
