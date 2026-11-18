---
schema: 1
id: 20261118080715-domain-note-identity-and-lifecycle
type: permanent
title: "Domain: note identity and lifecycle"
createdAt: "2026-11-18T08:07:15Z"
updatedAt: "2026-11-18T08:23:28Z"
tags:
  - domain
  - identity
  - lifecycle
  - storage
provenance:
  source: cli
  actor: user
---

A note's identity is its filename stem, `YYYYMMDDHHmmss-<kebab-slug>.md`. The 14-digit UTC prefix is the creation second; `createdAt` must agree with it and `updatedAt` must not precede it. The title slug is lowercased ASCII, at most 80 characters, cut on a hyphen boundary when possible; collisions add `-2`, `-3`. ID is used by show, edit, search, citations, HTTP routes, and MCP.

Creating a note trims the title and body, generates the filename, and writes a new file atomically with create-only semantics. Updating preserves the ID, `createdAt`, and unknown frontmatter, advances `updatedAt`, and may compare an expected SHA-256 so a stale base fails instead of clobbering. Editing the title does not rename the file; `check` may warn about slug drift but never renames or repairs. Changing type is an update, so reclassification moves no file.

Deleting moves the file to a per-root trash backup outside the note root, preferably by rename and copy when crossing filesystems; the repository does not simply unlink it. Humans delete directly after confirmation; MCP deletes are pending. `edit` refuses changes to `createdAt`, `updatedAt`, unknown keys, `legacyId`, `aliases`, and removal of provenance.

Evidence: [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts), [repository.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/repository.ts), [check.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/check.ts), [edit.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/edit.ts), [delete.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/delete.ts).

Related: [Markdown source of truth](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022814-markdown-files-are-the-only-source-of-truth.md), [trust boundary](https://github.com/blntrsz/slipmem/blob/main/.slipmem/20261118022816-the-local-trust-boundary-is-not-authentication.md).
