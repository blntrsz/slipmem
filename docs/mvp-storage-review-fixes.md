# Phase 1 Markdown storage review fixes

Date: 2026-11-18
Status: independent-review findings fixed and covered by regression tests.

This note records the storage-path review fixes for the Phase 1 Markdown
repository, index, and root resolution. It is reviewer evidence, not a second
contract: `docs/mvp-plan.md` section 5 and `packages/schemas/src/markdown.ts`
remain authoritative.

## Files changed

- `packages/core/src/markdown/atomic.ts`
- `packages/core/src/markdown/check.ts`
- `packages/core/src/markdown/frontmatter.ts`
- `packages/core/src/markdown/note-document.ts`
- `packages/core/src/markdown/paths.ts`
- `packages/core/src/markdown/repository.ts`
- `packages/core/src/markdown/root.ts`
- `packages/core/src/markdown/search-index.ts`
- `packages/core/src/markdown/{root,repository,search-index}.test.ts`
- `docs/mvp-storage-review-fixes.md` (this file)

No schema, package `index.ts`, shared log, server, web, CLI, MCP, or migration
file was edited. Concurrent work in other paths was left untouched.

## Findings and resolutions

| # | Finding | Resolution | Commit |
| --- | --- | --- | --- |
| 1 | An atomic update renamed a `0600` note over a temporary file created `0644`, widening permissions. | Overwrites read the existing regular file's mode and `fchmod` the temporary file to the exact bits before rename. Creates still use the requested mode and cannot inherit an unrelated file's mode. | `1f427eb` |
| 2 | A `forceLinearFallback` refresh updated `notes` but not `notes_fts`; the row counts still matched, so reopening in normal mode left stale FTS text. | The FTS meta flag records whether FTS was maintained. Reopening normal after a linear session rebuilds FTS even when counts match. Every repair now compares `title`, `body`, `reference`, and `topics` against the `notes` row instead of trusting counts. | `a2a6009` |
| 3 | `backupDir` and `cacheDir` could be a symlink into the note root, bypassing the lexical `isPathInside` check and then chmod/serving the root. | Both locations are resolved through their nearest existing ancestor (`realPathOf`) and checked against the real root before `mkdir`, `chmod`, or open. A symlinked cache/backup directory or `index.sqlite` is rejected with a typed error. | `6fd9ab3` |
| 4 | Refresh skipped a file whose size and mtime matched the indexed row, missing an external same-size edit made within one timestamp tick. | Refresh always reads the note and compares the SHA-256 content hash. Equal path and hash is the only unchanged case. This directly supports TRUTH-03. | `a2a6009` |
| 5 | `check` stripped any trailing `-<digits>` from the filename slug, so a title such as `Agent memory 2` reported false slug drift. | The exact slug is compared first. A collision suffix is stripped only for the secondary comparison. Genuine title drift still warns. | `8a4239a` |
| 6 | `parseProvenance` kept only `source` and `actor`, silently dropping nested application keys such as `model` or `run` on update. | Provenance keeps every nested key after validating the known fields. The existing unsafe-key scan still applies to the whole YAML mapping, and rendering carries the extra fields through an update. | `f37cff9` |
| 7 | A finite timestamp outside JavaScript's date range made `toUtcTimestamp` throw a `RangeError` defect from create/update. | Create and update validate finiteness and formatability through a typed `timestamp-invalid` error before rendering. A broken or out-of-range clock is reported, not raised as a defect, and no file is written. | `3e969b0` |
| 8 | Caller-supplied `unknown` metadata with an own `__proto__` key was silently dropped by rendering. | `createMarkdownNoteDocument` runs the same nested unsafe-key check as the parser for unknown metadata and provenance extras before rendering. The write fails with `frontmatter`/`malformed-yaml` and the offending field. | `d418e4e` |
| 9 | Ancestor lookup used `stat`, so a symlinked `.slipmem` resolved, then repository `lstat` rejected it as merely missing. | Root resolution, initialization, repository startup, and scan/list now reject a symlinked root with one actionable `symlink` error that names `SLIPMEM_DIR`. Ancestor discovery also notices a broken `.slipmem` symlink instead of reporting it as missing. Missing roots keep the existing missing-root error. | `ef03812`, `c488657` |

## Behavior notes

- **Permissions:** note updates preserve `0600`, `0640`, or `0644` as found.
  Creates do not copy modes from an existing path.
- **Index recovery:** the index remains disposable. FTS repair has two triggers:
  a session transition from linear fallback to FTS, and any text mismatch
  between the derived `notes` row and its FTS row. `check --rebuild-index`
  remains the operator recovery path.
- **Containment:** default XDG paths with symlinked intermediate components
  still work because only the real containment is checked. The final cache or
  backup directory component may not itself be a symlink, and no directory is
  chmodded until containment passes.
- **Root symlinks:** a symlinked `.slipmem` fails with
  `{ area: "repository", code: "symlink" }`. `check` reports the same issue
  instead of scanning through the link.
- **Provenance:** unknown nested values are preserved only as data. They are
  still frontmatter, not instructions, and the unsafe-key rule applies at every
  depth.

## Regression evidence

Each finding has a focused regression test:

| Finding | Test |
| --- | --- |
| 1 | `repository.test.ts` — preserves an existing restrictive file mode on update |
| 2 | `search-index.test.ts` — rebuilds stale FTS rows after a linear-fallback refresh; repairs FTS text drift even when the fts meta flag says healthy |
| 3 | `repository.test.ts` — backup directory symlink and ancestor-symlink cases; `search-index.test.ts` — cache directory and index-file symlink cases |
| 4 | `search-index.test.ts` — refreshes an external edit that preserves size and mtime |
| 5 | `repository.test.ts` — does not report drift for numeric titles or collision suffixes |
| 6 | `repository.test.ts` — preserves unknown nested provenance fields on update |
| 7 | `repository.test.ts` — reports out-of-range timestamps as typed failures, not defects |
| 8 | `repository.test.ts` — rejects dangerous unknown metadata keys before writing |
| 9 | `root.test.ts` — ancestor, broken-ancestor, env, and init symlink cases; `repository.test.ts` — symlinked root on open and check |

Commands run on the final tree:

```text
bun test packages/core/src/markdown
  88 pass, 0 fail, 615 expect() calls

bun run typecheck
  clean

bun run lint
  clean

bun run check
  292 pass, 0 fail; typecheck, lint, and web build clean
```

Automatic `get`/`list` behavior is unchanged: a symlinked note file is still
rejected, and only direct regular children matching the filename pattern are
notes.

## Commit sequence

```text
1f427eb Preserve note file mode on atomic updates
ef03812 Reject symlinked note roots with a typed error
c488657 Report broken ancestor root symlinks as symlinks
6fd9ab3 Contain backup and index directories through real paths
a2a6009 Refresh index by content hash and repair stale FTS text
8a4239a Compare exact slug before stripping collision suffixes
f37cff9 Preserve unknown nested provenance fields on update
d418e4e Reject dangerous unknown metadata before writing
3e969b0 Report out-of-range timestamps as typed Markdown errors
```

The fixes are limited to `packages/core/src/markdown/**` and this evidence
document. Approval, migration, MCP, server, and web storage behavior is
unchanged.
