---
schema: 1
id: 20261118080711-domain-literature-notes
type: permanent
title: "Domain: literature notes"
createdAt: "2026-11-18T08:07:11Z"
updatedAt: "2026-11-18T08:23:24Z"
tags:
  - domain
  - literature
  - source
provenance:
  source: cli
  actor: user
---

Literature notes record an external source: `type: literature`, a title, a body capped at 5000 characters, and a required non-blank `reference`. Both the Markdown parser and the literature slice enforce the reference rule; creation, update, and reclassification to literature fail without it. The reference is trimmed text, not a validated URL, and the body is untrusted data.

Human literature writes are direct. MCP literature create and update are direct; MCP delete is always pending. Reclassification between fleeting and literature is direct, while any move to or from permanent is pending.

Literature notes are cited by the wiki by default. Wiki selection ranks an exact tag first, then title, reference, and body matches; search weights reference above body. A source snapshot can be pinned in the reference text, for example a repository path plus a commit, without making the reference executable or authoritative.

`reference` is optional for fleeting and permanent notes and is preserved on unrelated updates. Unknown frontmatter keys are also preserved.

Evidence: [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts), [literature-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/literature-note.ts), [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts), [selection.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/selection.ts).

Related: [Markdown source of truth](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022814-markdown-files-are-the-only-source-of-truth.md), [trust boundary](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md).
