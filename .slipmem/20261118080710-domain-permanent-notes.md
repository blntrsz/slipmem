---
schema: 1
id: 20261118080710-domain-permanent-notes
type: permanent
title: "Domain: permanent notes"
createdAt: "2026-11-18T08:07:10Z"
updatedAt: "2026-11-18T08:23:23Z"
tags:
  - domain
  - permanent
  - lifecycle
provenance:
  source: cli
  actor: user
---

Permanent notes are durable memory: `type: permanent`, a title, and a body capped at 2000 characters. Title and body must be non-blank and are trimmed on write; `reference` is optional. Type and tags are frontmatter, never folders, so a note's path and stable ID survive reclassification.

Human permanent writes are direct. By default MCP permanent creates and updates are pending proposals, and every reclassification to or from permanent is pending. MCP deletes are pending for every type. `SLIPMEM_MCP_WRITE_POLICY=direct` selects the documented `direct-unsafe` mode: it bypasses pending only for permanent create, update, and reclassify, never for delete, and records `provenance.source: mcp-direct`. Unknown policy values fail closed to approval.

Proposals carry full proposed content plus a base content hash; approval revalidates the base, expiry, canonical path, and all note rules before the repository writes atomically. A stale or expired proposal writes nothing.

Permanent notes and literature notes are cited by the wiki by default; fleeting notes need opt-in. Search and tag counts include every type.

Evidence: [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts), [permanent-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/permanent-note.ts), [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts), [approval-service.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/approval-service.ts).

Related: [Markdown source of truth](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022814-markdown-files-are-the-only-source-of-truth.md), [trust boundary](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md).
