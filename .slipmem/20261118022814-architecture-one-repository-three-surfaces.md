---
schema: 1
id: 20261118022814-architecture-one-repository-three-surfaces
type: permanent
title: "Architecture: one repository, three surfaces"
createdAt: "2026-11-18T02:28:14Z"
updatedAt: "2026-11-18T02:55:38Z"
tags:
  - architecture
  - contracts
  - effect
provenance:
  source: cli
  actor: user
---

The architecture is one repository behind three interfaces. `packages/schemas` owns the executable contract: note types, limits, filename and tag patterns, metadata, approval proposals, and the wiki page shape. `packages/core` owns the Markdown repository, parser, atomic writes, lock, disposable index, approval, wiki, and migration importer. CLI, MCP, server, and web are adapters over core.

Data flow is files -> `MarkdownNoteRepository` -> services -> surfaces. The server wires one repository instance into the index, approval, and wiki services with `makeMarkdownLayer`, so an approval and a later search observe the same files. The MCP layer uses the same shape. The Foldkit web entry mounts the HTTP handler in the same process.

Canonical HTTP routes are ID-based (`/api/notes/:id`, `/api/search`, `/api/tags`, `/api/wiki/:tag`, `/api/pending`). Legacy `/api/notes/:type` routes are thin adapters that resolve through the same repository and never create type folders. MCP exposes bounded reads plus policy-enforced writes; no MCP tool can approve a proposal.

Contract ownership is deliberate. Surfaces import schema constants and helpers instead of reimplementing filename, tag, or limit rules. The parser keeps the raw unknown frontmatter mapping because decoding a struct would drop unknown keys. Surfaces translate core errors into response shapes.

The `topics` -> `tags` rename shows the pattern: change the schema/parser/index contract once, then update CLI, MCP, server, web, and docs. One compatibility rule remains: legacy `topics` is read as `tags` and rewritten on the next write. Both keys are rejected only when both are non-null; `tags: null` is absent, so `topics` still wins. No public `--topic` alias remains; the index version bump discards old caches. Put a new rule in its owning package and let surfaces adapt.

Evidence: `README.md:49-61`, `packages/server/src/markdown.ts:25-59`, `packages/mcp/src/layer.ts:10-34`, `packages/schemas/src/markdown.ts:3-22`.
