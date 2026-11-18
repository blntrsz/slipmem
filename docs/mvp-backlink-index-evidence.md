# Derived backlink index evidence

Status: **implemented and tested in the disposable search index.**
Date: 2026-11-18
Authority: [`docs/mvp-plan.md`](./mvp-plan.md) sections 5.5, 5.6, and 6.1;
[`docs/mvp-link-check-evidence.md`](./mvp-link-check-evidence.md) section 4;
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md) gap G2.

This slice closes G2: the index now persists internal link/backlink rows derived
from Markdown files and exposes a bounded typed lookup. The note files remain the
only authority. The SQLite cache is disposable and can be deleted at any time.

Owned files:

- `packages/core/src/markdown/search-index.ts`
- `packages/core/src/markdown/search-index.test.ts`
- `docs/mvp-backlink-index-evidence.md`

No note, repository, CLI, MCP, web, migration, or shared documentation file was
changed by this workstream.

## 1. Derived schema

`INDEX_SCHEMA_VERSION` is `2`. A version mismatch drops the derived tables and
recreates them; there is no migration and no attempt to preserve cached rows.
This is the same recovery contract the index already had, extended to links.

```sql
CREATE TABLE links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  resolved INTEGER NOT NULL
);
CREATE INDEX links_target ON links (target_id, resolved, source_id);
CREATE INDEX links_source ON links (source_id);
```

Rows contain only note IDs, the one-based source line, the link kind, and a
resolution flag. They do not contain note text, raw destinations, or filesystem
paths beyond the source path already stored in `notes`. Unsafe and malformed
references are not cached; they remain `check` diagnostics. Candidate links with
no target note are stored with `resolved = 0` (dangling), so a later refresh can
resolve them when the target appears without treating the index as authority.

## 2. Sharing the parser

`search-index.ts` imports `extractInternalMarkdownLinks` and
`MarkdownLinkReference` from `check.ts`. Link extraction and its code-fence,
inline-code, comment, escape, anchor, external-URL, and traversal rules are not
duplicated. The index only applies the same `.md` suffix normalization that
`check` applies before matching a candidate against the root's note IDs.

## 3. Refresh and rebuild behavior

`refresh()` continues to read every note file and compare the content hash, not
just size and mtime. After notes are added, updated, or removed, it replaces the
whole derived link set from the current `notes` rows in one transaction. This
makes these transitions consistent without background watchers or note writes:

- An external body edit adds, removes, or moves links.
- An external note deletion removes its outgoing rows and makes incoming
  candidate links dangling (`resolved = 0`) until a target with that ID exists.
- A newly indexed target resolves previously dangling rows on the next refresh.
- `rebuild()` and `clear()` empty `links` with `notes`; `rebuild()` then derives
  the same identities from the files.
- A cache directory deleted by the operator rebuilds the same note IDs, hashes,
  search results, and backlink identities from copied or original Markdown.
- The linear fallback still derives links because `index.sqlite` exists; FTS5 is
  only a search capability. Backlinks do not depend on `notes_fts`.

`IndexRefreshStats.links` reports the number of persisted candidate rows,
including dangling rows.

## 4. Backlink API

`MarkdownSearchIndexShape` adds:

```ts
backlinks(
  noteId: string,
  limit?: number,
): Effect.Effect<ReadonlyArray<MarkdownBacklinkSource>, MarkdownError>
```

```ts
interface MarkdownBacklinkSource {
  id: string        // source note ID
  path: string      // source note path from the derived notes row
  linkCount: number // resolved cross-note occurrences
  lines: number[]   // sorted, deduplicated one-based source lines
}
```

Rules:

- Only `resolved = 1` candidate links are returned. Self-links, dangling links,
  unsafe links, malformed links, and external URLs are excluded.
- The default limit is `DEFAULT_BACKLINK_LIMIT` (20); the hard bound is
  `MAX_BACKLINK_LIMIT` (100). Non-finite values use the default; fractional
  values are truncated; values outside the range are clamped. The limit bounds
  source notes, not occurrences.
- Results are ordered by source path, then source ID. An unknown or empty note ID
  returns an empty array rather than reading or creating a file.
- The API reads only the derived `links` and `notes` tables. It never resolves a
  path, opens a note, repairs a note, or writes outside the cache.

`MarkdownBacklinkSource` is exported from
`packages/core/src/markdown/index.ts` through the existing wildcard export. The
top-level `packages/core/src/index.ts` barrel is shared ownership and was not
edited here; add the type there if a package-root consumer needs the name.

## 5. Tests

`packages/core/src/markdown/search-index.test.ts` adds four tests:

1. **Persistence and bounds.** Two sources link to the same target, including two
   links on one line, a self-link, a dangling ID, and an unsafe traversal link.
   The rebuild reports six candidate rows. Backlinks return both sources with
   counts and lines, exclude self/dangling lookups, clamp `limit: 1`, expose
   schema version `2`, and the SQLite file contains six rows, one dangling row,
   and the stored self-link row.
2. **External refresh and deletion.** An external edit switches a source link
   from the permanent note to the literature note; refresh updates both
   backlink sets. Deleting the target leaves the source row dangling
   (`resolved = 0`) and returns no backlinks. Deleting the source removes its
   rows.
3. **Cache loss and copied notes.** Removing the cache directory and rebuilding
   returns identical backlink entries. Copying the Markdown files into a new
   root with a new cache rebuilds the same source identity and occurrence count
   with the new root's path.
4. **Linear fallback.** With `forceLinearFallback: true` and an existing SQLite
   cache, rebuild mode is `linear`, one link row is persisted, and the backlink
   lookup returns the source. FTS5 absence does not disable backlinks.

Existing index tests continue to cover FTS repair, external edits preserving size
and mtime, path/symlink refusals, user-only permissions, and the `NoteService`
adapter. The schema test now simulates a version 1 cache with no `links` table,
reopens it, and confirms the version 2 rebuild recreates backlinks from files
without a migration.

## 6. Verification

Commands run from the repository root:

```text
bun test packages/core/src/markdown/search-index.test.ts
  20 pass, 0 fail, 105 expect() calls

bunx oxlint packages/core/src/markdown/search-index.ts packages/core/src/markdown/search-index.test.ts
  exited 0 with no diagnostics
```

The full repository gate also passed after the concurrently running migration
work settled:

```text
bun run check
  oxlint: clean
  tsc --noEmit && tsc --noEmit -p packages/web/tsconfig.json: clean
  bun test: 370 pass, 0 fail, 3140 expect() calls (44 files)
  vite build (client and SSR): passed
```
