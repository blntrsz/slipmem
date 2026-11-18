---
schema: 1
id: 20261118080714-domain-search-and-index
type: permanent
title: "Domain: search and index"
createdAt: "2026-11-18T08:07:14Z"
updatedAt: "2026-11-18T08:07:14Z"
tags:
  - domain
  - search
  - index
provenance:
  source: cli
  actor: user
---

The search index is disposable derived state, never a note source. It lives at `$XDG_CACHE_HOME/slipmem/index/<root-key>/index.sqlite` with `~/.cache` fallback; schema-version changes drop and rebuild old caches. The file can contain note text, so it inherits the plaintext trust boundary. `check --rebuild-index` reconstructs it; `cache clear` removes only the cache.

Search covers title, body, reference, and tags. Queries are trimmed, limited to 512 characters and 16 unique lowercased tokens. Every token must match, while each token may match any selected field. FTS5 uses BM25 weights title 5, body 1, reference 3, tags 2; the linear fallback applies the same weights. Ties order by newest `updatedAt`, then ID. The default limit is 10 and the hard maximum is 50. Optional type and exact normalized tag filters apply before the limit.

Tag counts come from the same index: default 50, maximum 200, sorted by count then slug. Backlinks are derived from internal note links, with 20 sources by default and a maximum of 100, excluding self, malformed, unsafe, and dangling references. CLI search and tags refresh the index first, so external file edits are visible.

Evidence: [search-index.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/search-index.ts), [search.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/search.ts), [tags.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/tags.ts), [README.md](https://github.com/blntrsz/slipmem/blob/main/README.md).

Related: [.slipmem/20261118022814-markdown-files-are-the-only-source-of-truth.md](20261118022814-markdown-files-are-the-only-source-of-truth.md), [.slipmem/20261118022814-architecture-one-repository-three-surfaces.md](20261118022814-architecture-one-repository-three-surfaces.md).
