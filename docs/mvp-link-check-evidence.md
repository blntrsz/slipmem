# Internal link and backlink check evidence

Status: **implemented and tested in the core check path.**
Date: 2026-11-18
Authority: [`docs/mvp-plan.md`](./mvp-plan.md) sections 5.2, 5.6, 7.1, 12,
13.1, 13.7; [`docs/mvp-implementation-log.md`](./mvp-implementation-log.md).

This slice closes the `validate ... links` promise in `slipmem check`. It adds
read-only link validation and a derived backlink view to
`packages/core/src/markdown/check.ts` only. It does not edit the repository,
search index, lock, root, CLI, or migration code owned by other workstreams.

## 1. Contract implemented

`checkNoteRoot` now derives link health from each valid note body on every run.
It does not read, write, or repair a note file.

| Reference form | Example | Result |
| --- | --- | --- |
| Wikilink | `[[20261117193045-note]]` | validated against the root's stable note IDs |
| Wikilink alias | `[[20261117193045-note\|display]]` | same target validation, alias ignored |
| Wikilink anchor | `[[20261117193045-note#heading]]` | target validated, fragment ignored |
| Wikilink `.md` suffix | `[[20261117193045-note.md]]` | suffix stripped before ID validation |
| Direct file link | `[note](20261117193045-note.md)` | filename validated against the root's stable IDs |
| Relative direct link | `[note](./20261117193045-note.md#heading)` | leading `./`, fragment, and query normalized |
| Reference definition | `[ref]: 20261117193045-note.md` | destination validated as a direct `.md` link |
| Same-note anchor | `[jump](#heading)`, `[[#heading]]` | valid; not a cross-note link |
| External URL | `https://example.com/note.md`, `mailto:...` | ignored as external, never treated as local |
| Protocol-relative URL | `//example.com/note.md` | ignored as external |
| Non-`.md` relative target | `[asset](./diagram.png)` | ignored; check only claims note-file links |
| Fenced code | ` ``` ... [[missing]] ... ``` ` | ignored |
| Inline code | `` `[[missing]]` `` | ignored |
| HTML comment | `<!-- [[missing]] -->` | ignored |
| Escaped link | `\[[missing]]`, `\[missing](missing.md)` | ignored |

`NoteCheckReport.links` exposes:

```ts
{
  checked: number,
  broken: number,
  backlinks: Array<{ id: string, sources: string[] }>
}
```

`checked` counts internal references that were evaluated. `broken` counts
malformed, unsafe, and missing-target references. `backlinks` is sorted by
target ID and source ID, and excludes self-links. It is recomputed, not
persisted.

## 2. Diagnostics

Every issue points at the source note and carries `area: "body"`,
`field: "body"`, and the body line number in the message.

| Code | Severity | Meaning |
| --- | --- | --- |
| `broken-link` | error | The wikilink stem or direct `.md` filename has no matching note ID in this root. |
| `unsafe-link` | error | The reference uses traversal, an absolute path, a Windows drive/UNC path, backslash separator injection, percent-encoded traversal, or a nested path. |
| `malformed-link` | error | A wikilink has an empty target, such as `[[ ]]`. `[[#heading]]` remains valid. |

Notes stay untouched. Conflict markers continue to be reported by the existing
parser path, and the conflict-preservation test compares every note byte before
and after `check`.

## 3. Safety behavior

- URI schemes are recognized before `.md` suffix checks, so
  `https://example.com/note.md` is external even though it ends in `.md`.
- Percent escapes are decoded up to two passes, so `%2e%2e/secret.md` is
  reported as unsafe traversal rather than a harmless missing note.
- Internal targets must be a direct note ID or direct `.md` filename in the flat
  root. A nested local path is rejected instead of being resolved.
- No link so far triggers filesystem access. Validation is pure string work
  against the already scanned note set.
- Existing 1 MiB read bound and repository scan behavior are unchanged.
- No note content is rendered as HTML or executed.

## 4. Backlink derived data boundary

The existing search index has no link or backlink API, and this workstream does
not edit `packages/core/src/markdown/search-index.ts`. To avoid a blocking
dependency, `check` computes backlinks from the same in-memory scan and returns
them in `NoteCheckReport.links.backlinks`.

Remaining work for the orchestrator: if persisted backlink lookup is required by
MCP, search, or web surfaces, add a disposable backlink table/API to the search
index and feed it through `extractInternalMarkdownLinks` or an equivalent shared
extractor. Until then, backlinks are check-time derived data only, matching the
plan's rule that the index is disposable.

The top-level `packages/core/src/index.ts` barrel was outside this workstream's
ownership, so `extractInternalMarkdownLinks`, `MarkdownLinkReference`, and
`NoteBacklink` are exported from `check.ts` and the Markdown module index, but
are not yet listed in the package barrel. Add them there if a surface needs the
extractor directly.

## 5. Tests

New file: `packages/core/src/markdown/check-links.test.ts`.

Coverage:

1. Pure extraction ignores code fences, inline code, HTML comments, escaped
   links, anchors, and external URLs while returning wikilink, direct `.md`, and
   reference-definition candidates.
2. End-to-end `checkNoteRoot` accepts aliases, anchors, `./` prefixes, `.md`
   wikilink suffixes, queries, reference definitions, and external URLs; reports
   nine checked links and one backlink; and leaves the note bytes unchanged.
3. End-to-end check reports nine broken, malformed, and path-injection
   references with source path, `body` field, and line number.
4. Multiple sources produce sorted backlinks; self-links are excluded.
5. A conflict-marker fixture is still reported and every note remains
   byte-for-byte identical.

## 6. Verification

Commands run from the repository root:

```text
bun test packages/core/src/markdown/check-links.test.ts
  5 pass, 0 fail, 67 expect() calls

bunx oxlint packages/core/src/markdown/check.ts packages/core/src/markdown/check-links.test.ts
  exited 0 with no diagnostics
```

The repository-wide typecheck was also run. It previously passed during this
slice, but a final rerun picked up unrelated, in-progress changes from other
workstreams in `packages/cli/src/wrappers.test.ts` and
`packages/core/src/migration/migration-plan.ts`; it reported no diagnostics in
the link-check files.

The full suite was attempted while other workstreams were actively editing
`packages/core/src/markdown/lock.ts`. It was not a valid signal: unrelated
repository, index, and migration tests failed with
`Could not create the repository lock: startHeartbeat is not defined`. The
link-check test file and lint check were run independently and passed. Re-run
`bun run check` after the other workstreams settle.
