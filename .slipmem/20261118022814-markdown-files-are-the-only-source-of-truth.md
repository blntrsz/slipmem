---
schema: 1
id: 20261118022814-markdown-files-are-the-only-source-of-truth
type: permanent
title: Markdown files are the only source of truth
createdAt: "2026-11-18T02:28:14Z"
updatedAt: "2026-11-18T08:10:37Z"
tags:
  - architecture
  - storage
  - reliability
provenance:
  source: cli
  actor: user
---

`.slipmem/` is the only source of truth. Every note is a direct child named `YYYYMMDDHHmmss-<kebab-slug>.md`; the filename stem is the stable ID used by citations, links, API routes, and MCP. There are no type or date folders. Type, tags, reference, and provenance are YAML frontmatter; unknown keys are preserved.

Required metadata is `schema`, `id`, `type`, `title`, `createdAt`, `updatedAt`. `createdAt` must agree with the 14-digit UTC prefix, `updatedAt` must not precede it, and literature needs a non-blank `reference`. A title edit does not rename the file; `check` may warn about slug drift but never repairs it.

Writes are atomic and serialized: a same-directory temp file is fsynced and renamed; creates use a hard link so existing files cannot be overwritten. Mutations lock under `.state/`; update/delete accept an expected content hash so stale bases fail.

Local state stays out of the portable note set. `.slipmem/.state/` holds locks, pending proposals, migration state, and quarantine; the generated `.slipmem/.gitignore` ignores exactly `.state/`. The FTS index lives under `$XDG_CACHE_HOME/slipmem/index/<root-key>/index.sqlite` (fallback `~/.cache`), is derived, and can be deleted or rebuilt. Deleted notes move to the XDG trash.

Root resolution is `SLIPMEM_DIR`, then the nearest ancestor `.slipmem/`; only `init` creates it. SQLite is not a runtime note store; `SLIPMEM_DB_PATH` names only the legacy migration file. Internal links must be a direct note ID or `.md` filename in the flat root; traversal, absolute paths, and separator injection are rejected.

Evidence: [paths.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/paths.ts), [atomic.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/atomic.ts), [search-index.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/search-index.ts), [operator-guide.md](https://github.com/blntrsz/slipmem/blob/main/docs/operator-guide.md).
