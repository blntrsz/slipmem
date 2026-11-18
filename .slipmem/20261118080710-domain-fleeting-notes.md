---
schema: 1
id: 20261118080710-domain-fleeting-notes
type: permanent
title: "Domain: fleeting notes"
createdAt: "2026-11-18T08:07:10Z"
updatedAt: "2026-11-18T08:23:22Z"
tags:
  - domain
  - fleeting
  - lifecycle
provenance:
  source: cli
  actor: user
---

Fleeting notes are the low-trust inbox: `type: fleeting`, a title, and a body capped at 1000 characters. The cap is defined once in the shared Markdown contract and mirrored by the fleeting slice schema. Title and body must be non-blank and are trimmed on write; `reference` is optional.

Human fleeting writes are direct. MCP fleeting create and update are direct; MCP delete is always pending. Reclassification between fleeting and literature is direct, while any move to or from permanent is pending. Type is frontmatter metadata, so reclassification never moves or renames the file.

Identity and recall are shared with every type: the filename stem is the stable ID, tags use the common slug rules, and the note appears in list, search, and tag counts. The cited wiki excludes fleeting notes unless the caller opts in, so cheap capture does not silently become cited knowledge.

Evidence: [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts), [fleeting-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/fleeting-note.ts), [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts), [selection.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/selection.ts).

Related: [Markdown source of truth](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022814-markdown-files-are-the-only-source-of-truth.md), [trust boundary](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md).
