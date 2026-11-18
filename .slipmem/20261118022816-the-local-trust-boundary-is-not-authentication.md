---
schema: 1
id: 20261118022816-the-local-trust-boundary-is-not-authentication
type: permanent
title: The local trust boundary is not authentication
createdAt: "2026-11-18T02:28:16Z"
updatedAt: "2026-11-18T08:10:41Z"
tags:
  - security
  - approval
  - domain
provenance:
  source: cli
  actor: user
---

slipmem is local-first, not a hardened multi-user service. The real boundary is the loopback bind plus filesystem permissions, not the approval UI. Notes are plaintext: anyone who can read `.slipmem/`, the index cache, or the trash can read them. Do not store secrets.

The HTTP API and `/mcp` are unauthenticated and bind to `127.0.0.1` by default. A non-loopback `HOST` exposes every note and prints a warning. Mutations are same-origin only; cross-site fetch metadata is refused. Note text is untrusted and rendered as text/Markdown, never trusted HTML.

Agent writes use a server-enforced policy:
- Human CLI/web writes are direct.
- MCP fleeting and literature writes are direct; the `reference` rule applies.
- MCP permanent creates/updates and reclassification to or from permanent are pending.
- MCP deletes are always pending. `SLIPMEM_MCP_WRITE_POLICY=direct` selects `direct-unsafe`, which bypasses pending only for permanent create/update/reclassify, never deletes, and records `provenance.source: mcp-direct`.

Pending proposals live under `.slipmem/.state/pending/`, never in notes, search, tags, or root. The agent gets `pending_approval`; a human reviews and approves or rejects. Approval revalidates the base hash, expiry, and note rules; stale or expired proposals write nothing. `review`, `apply`, and `reject` are human-only and never MCP tools. `SLIPMEM_ACTOR` is metadata, not authentication.

Approval is a local policy gate, not an OS sandbox; another local process can bypass it and edit files directly. Synthesized wiki pages need a configured local agent or adapter, normally sandboxed; `SLIPMEM_WIKI_AGENT_UNSAFE=1` is an explicit unsafe override with full privileges. Extractive mode is always available.

Evidence: [README.md](https://github.com/blntrsz/slipmem/blob/main/README.md), [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts), [operator-guide.md](https://github.com/blntrsz/slipmem/blob/main/docs/operator-guide.md).
