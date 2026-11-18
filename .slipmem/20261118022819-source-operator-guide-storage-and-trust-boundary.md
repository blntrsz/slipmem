---
schema: 1
id: 20261118022819-source-operator-guide-storage-and-trust-boundary
type: literature
title: "Source: operator guide storage and trust boundary"
createdAt: "2026-11-18T02:28:19Z"
updatedAt: "2026-11-18T02:55:40Z"
tags:
  - source
  - security
  - operations
reference: docs/operator-guide.md §2, §3, §9, §10 (repository commit 8094950)
provenance:
  source: cli
  actor: user
---

This literature note summarizes `docs/operator-guide.md` as a pinned snapshot at repository commit 8094950, sections 2, 3, 9, and 10. It describes behavior that exists in the tree, not planned commands.

Storage. The portable artifact is one flat directory of Markdown files, normally `.slipmem/` at the repository root. Every note is a direct child named `YYYYMMDDHHmmss-<kebab-slug>.md`; the filename stem is the ID used by `show`, `edit`, search, citations, and MCP. There are no type or date subdirectories. Type and tags are frontmatter. `.slipmem/.state/` holds locks, pending proposals, migration runs, and quarantine; the generated `.slipmem/.gitignore` contains exactly `.state/`, so notes, README, and the ignore file are tracked while state is not. Deleted notes move to the XDG state trash, not an in-place unlink. The search index lives under `$XDG_CACHE_HOME/slipmem/index/<root-key>/index.sqlite`, falling back to `~/.cache`; it is disposable and may contain note text.

Trust boundary. Note files are plaintext and unencrypted. Anyone who can read the directory or cache can read the notes, so no secrets, credentials, or sensitive personal data. `init` is idempotent and creates the root, `.state/`, a starter README, and `.gitignore`; it never deletes. Root resolution is `SLIPMEM_DIR`, then the nearest ancestor `.slipmem/`; only `init` creates a root. A missing root stops startup instead of creating one.

Everyday invariants. `edit` refuses changes to createdAt, updatedAt, unknown keys, `legacyId`, and `aliases`; use `check` after hand edits. A title change does not rename the file; `check` may warn about slug drift. Legacy `topics` frontmatter is read as `tags` and rewritten as `tags` on the next save. A note is rejected only when both `tags` and `topics` are non-null; `tags: null` counts as absent, so the `topics` list still loads. Content is validated against the per-type limits before an atomic write.

Agent access. The stdio MCP server and HTTP `/mcp` expose bounded read tools and policy-enforced write tools. MCP permanent creates/updates and reclassification to or from permanent become pending proposals; fleeting and literature writes, including reclassification between them, are direct; all deletes are pending. `review` shows the summary and diff; `approve` applies only if the base hash and rules still match; `reject` removes the proposal without touching notes. No MCP tool can approve. `SLIPMEM_MCP_WRITE_POLICY=direct` is the documented unsafe opt-in for permanent create/update/reclassify, never deletes, and it records `mcp-direct` provenance. `SLIPMEM_ACTOR` identifies an actor but is not authentication. Pending proposals never appear in the note list, search, tags, or note root.

HTTP posture. The API and `/mcp` are unauthenticated and bind to `127.0.0.1` by default. `HOST` selects another address and prints a warning. Mutations are same-origin only and require JSON; no CORS access is enabled. Note text is untrusted and rendered as text/Markdown, never trusted HTML. Approval is a local policy gate, not authentication or an OS sandbox: another local process that can reach the loopback port can bypass it and edit the Markdown files directly. The loopback bind and file permissions are the real boundary.

Recovery. `check --rebuild-index` reconstructs the derived cache from the notes; `cache clear` empties only the cache. Migration from SQLite is a separate, non-destructive command, and SQLite is not the runtime note store.

Use this note for operational expectations. The implementation notes carry current APIs and code pointers.
