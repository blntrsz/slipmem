---
schema: 1
id: 20261118022818-source-mvp-plan-principles-architecture-and-security
type: literature
title: "Source: MVP plan principles, architecture, and security"
createdAt: "2026-11-18T02:28:18Z"
updatedAt: "2026-11-18T02:28:18Z"
tags:
  - source
  - architecture
  - domain
reference: docs/mvp-plan.md §4, §6, §8, §9, §12 (repository commit 8094950)
provenance:
  source: cli
  actor: user
---

This literature note summarizes the authoritative MVP plan at `docs/mvp-plan.md` (repository commit 8094950). The plan uses the historical word "topic"; the current implementation calls the same metadata "tags" after the rename. The principles and boundaries below are unchanged.

Principles. Files over databases: the SQLite index is a cache, and losing it must never lose a note. Flat by default: type is metadata, not a directory, so reclassification does not move files. Stable identity: the filename stem is the ID used by links, citations, API responses, and MCP. Humans approve permanent memory; low-trust capture is cheap, durable knowledge and deletion are deliberate. Data is not authority: note text, titles, links, and references are untrusted and never become instructions, permissions, or shell commands. Bounded recall: every list, search, and wiki operation has a default limit and hard maximum. Every claim is traceable: wiki output identifies the note file and ID, and synthesized sentences without a supporting span are rejected or omitted. Local by default: HTTP surfaces bind to loopback unless the operator opts out. No silent destruction: atomic writes, approval for agent deletes, non-destructive migration, and no automatic Git operations.

Storage and architecture. A note is YAML frontmatter plus a Markdown body. The filename is `YYYYMMDDHHmmss-<slug>.md`; only matching files are notes. Required metadata is schema, ID, type, title, createdAt, and updatedAt; createdAt agrees with the UTC prefix. Fleeting/permanent/literature bodies are limited to 1000/2000/5000 characters, and literature requires a reference. `.slipmem/.state/` holds local non-note state. The derived index lives outside the root under the XDG cache. Components are schemas, core (repository/parser/atomic write/lock/index/wiki), CLI, MCP, server, and Foldkit web. The data flow is files -> repository -> services -> CLI, MCP, and web/API. One repository interface serves every surface, and stdio/HTTP MCP share registrations.

Approval. The policy matrix makes human writes direct; MCP fleeting/literature writes direct; MCP permanent creates/updates and reclassification pending; MCP deletes always pending. A proposal records expiry, operation, target ID/path, base hash, proposed content, actor, and source. Approval revalidates the base hash and all rules, writes atomically, refreshes the index, and removes the proposal. Approve/reject are human-only, never MCP tools. Proposals are local state, not notes.

Wiki. Generation is on demand and read-only. Selection normalizes the tag, prefers exact tag matches, then bounded text matches; permanent and literature notes are cited by default, fleeting only with opt-in; default limit 10, maximum 25. Extractive mode quotes each note with an ID and file citation. Synthesized mode gives a configured model or agent only the bounded note set, with no tools or write authority; a citation validator drops unsupported sentences.

Security. Paths are direct children matching the filename pattern; traversal, absolute paths, and symlinks escaping the root are rejected. Reads reject files over 1 MiB; frontmatter parsing rejects executable YAML. Recall defaults to 10 and caps at 50 for list/search. Wiki caps at 25 notes and bounded output. The HTTP server is unauthenticated and loopback by default, with no permissive CORS. Notes are plaintext, so MCP instructions forbid secrets. Deletion prefers trash/backup. One writer lock and atomic temp-file-plus-rename writes handle concurrency. Git is never automated.

Use this note for durable product intent. Use the implementation notes for current field names, routes, and commands; where the plan and current code differ on vocabulary, the code and current README win.
