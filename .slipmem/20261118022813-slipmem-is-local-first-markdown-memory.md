---
schema: 1
id: 20261118022813-slipmem-is-local-first-markdown-memory
type: permanent
title: slipmem is local-first Markdown memory
createdAt: "2026-11-18T02:28:13Z"
updatedAt: "2026-11-18T02:28:29Z"
tags:
  - domain
  - architecture
  - storage
provenance:
  source: cli
  actor: user
---

slipmem is local-first memory for one person and the coding agents that work with them. The portable artifact is a flat directory of Markdown notes, normally `.slipmem/` at the repository root. The CLI, MCP server, and Foldkit web app are interfaces over those same files, not separate stores.

Three types encode trust and lifecycle:
- `fleeting` is a low-trust inbox: cheap capture, 1000-character body.
- `permanent` is durable memory: 2000-character body, and agent creates, updates, and reclassification wait for human approval by default.
- `literature` records an external source: 5000-character body plus a required non-blank `reference`.

Type is frontmatter metadata, not a folder. Tags are lowercase kebab-case metadata; they are not directories and do not change a note's path. A note's identity is its filename stem `YYYYMMDDHHmmss-<slug>`, stable across title edits.

Derived surfaces never become a second source of truth. Search, tag counts, backlinks, and cited tag pages are rebuilt on demand from the files. The SQLite index is disposable, lives under the XDG cache, and losing it loses no note. Wiki pages are generated for reading, not persisted as notes.

Interfaces differ in trust: human CLI and web writes are direct after validation; MCP writes use the approval policy; HTTP binds to loopback by default. Files are plaintext, so no secrets, credentials, or sensitive personal data belong in notes.

Evidence: `README.md:3-7`, `README.md:31-61`, `packages/schemas/src/markdown.ts:25-39`, `docs/mvp-plan.md:108-131`.

Related notes: [[20261118022814-markdown-files-are-the-only-source-of-truth]], [[20261118022816-the-local-trust-boundary-is-not-authentication]].
