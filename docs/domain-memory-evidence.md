# Domain memory evidence

Status: evidence for the eight separate domain reference notes added to
`.slipmem/` on 2026-11-18. The general note-set evidence and review corrections
remain in [repository memory evidence](repository-memory-evidence.md). This
document records domain coverage, sources, content rules, validation, and the
interpretations that were not fully specified by the request.

## Baseline and scope

- Code baseline: `1d5a7a4` (`Treat a null tags field as absent in legacy
  parsing`). No application code changed in this expansion.
- Tree used for the work: `ca449a6`.
- Changed paths: `.slipmem/**`, this file, and
  `docs/repository-memory-evidence.md`.
- Source, schema, app, test, and historical evidence files were not edited.
- The application's internal note-linking defaults were not changed. The wiki
  renderer still emits its own runtime link form; this work only changes stored
  note content.

## Domain notes

Eight permanent documentation notes were created with `slipmem new` and
repeated `--tag`. Each covers one cohesive implemented domain and is a separate
file.

| ID | Title | Tags | Body |
| --- | --- | --- | --- |
| `20261118080710-domain-fleeting-notes` | Domain: fleeting notes | `domain`, `fleeting`, `lifecycle` | 1575 |
| `20261118080710-domain-permanent-notes` | Domain: permanent notes | `domain`, `permanent`, `lifecycle` | 1831 |
| `20261118080711-domain-literature-notes` | Domain: literature notes | `domain`, `literature`, `source` | 1764 |
| `20261118080712-domain-tags` | Domain: tags | `domain`, `tags` | 1745 |
| `20261118080713-domain-approvals-and-proposals` | Domain: approvals and proposals | `domain`, `approval`, `security` | 1967 |
| `20261118080714-domain-cited-wiki` | Domain: cited wiki | `domain`, `wiki` | 1975 |
| `20261118080714-domain-search-and-index` | Domain: search and index | `domain`, `search`, `index` | 1825 |
| `20261118080715-domain-note-identity-and-lifecycle` | Domain: note identity and lifecycle | `domain`, `identity`, `lifecycle`, `storage` | 1986 |

All eight are `type: permanent` with `provenance.source: cli` and
`provenance.actor: user`. A domain's subject does not set the note type: the
fleeting-notes document is not a fleeting note, and the literature-notes
document is not a literature note, because both are durable canonical
documentation rather than inbox capture or external-source summaries.

`.slipmem/README.md` is the non-note domain map. It links every domain note so
the set is discoverable without search.

## Coverage decisions

The existing eight notes already cover the local-first overview, Markdown as
the source of truth, the package architecture, the Effect service cookbook, the
Foldkit UI, the trust boundary, and the two pinned source snapshots. The new
files cover implemented domains that lacked a focused reference:

- Note-type slices: fleeting, permanent, and literature rules and limits.
- Metadata and recall: tags.
- Agent write lifecycle: approvals and proposals.
- Derived read surfaces: cited wiki, search and index.
- Lifecycle and identity: stable IDs, create/update/delete/reclassification.

Storage, atomic writes, root resolution, and the trust boundary stay in the
existing notes instead of being duplicated. Type notes link to the relevant
existing notes, and the README maps the rest.

## Source checks

Every domain note carries a short `Evidence` line with `main`-branch GitHub
links. The primary sources are:

- Shared contract: [markdown.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/markdown.ts)
  defines note types, 1000/2000/5000 body limits, filename and tag patterns,
  `MAX_SLUG_LENGTH` 80, `MAX_TAG_LENGTH` 64, metadata validation, approval
  proposal unions, and wiki page shapes.
- Type slices:
  [fleeting-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/fleeting-note.ts),
  [permanent-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/permanent-note.ts),
  and [literature-note.ts](https://github.com/blntrsz/slipmem/blob/main/packages/schemas/src/literature-note.ts).
- Parser and metadata:
  [note-document.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/note-document.ts)
  validates filename, schema, ID, timestamps, tags, reference, body limits,
  conflict markers, and preserves unknown keys.
- Repository and lifecycle:
  [repository.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/repository.ts)
  implements create/update/delete, expected content hashes, trash backup, and
  the lock boundary. [check.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/check.ts)
  validates links, duplicate IDs, slug drift, and index fingerprints.
- Approval policy and storage:
  [policy.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/policy.ts),
  [approval-service.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/approval-service.ts),
  and [proposal-store.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/approval/proposal-store.ts).
- Wiki:
  [selection.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/selection.ts),
  [render.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/render.ts),
  [wiki-service.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/wiki-service.ts),
  and [synthesis.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/wiki/synthesis.ts).
- Search and index:
  [search-index.ts](https://github.com/blntrsz/slipmem/blob/main/packages/core/src/markdown/search-index.ts)
  defines FTS5/linear search, field weights, limits, tag counts, and backlinks.
- CLI surfaces:
  [new.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/new.ts),
  [edit.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/edit.ts),
  [delete.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/delete.ts),
  [tags.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/tags.ts),
  [search.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/search.ts),
  and [wiki.ts](https://github.com/blntrsz/slipmem/blob/main/packages/cli/src/commands/wiki.ts).

The two literature notes now use commit-pinned GitHub references:

- [docs/mvp-plan.md at 8094950](https://github.com/blntrsz/slipmem/blob/8094950/docs/mvp-plan.md)
- [docs/operator-guide.md at 8094950](https://github.com/blntrsz/slipmem/blob/8094950/docs/operator-guide.md)

Their note bodies use the same commit pin. Implementation evidence links use
`main`, so the links become resolvable after the repository is pushed. No
newly created note was fetched from GitHub during this work.

## Link convention

- Inter-note links are GitHub-flavored Markdown links. The label names the
  path, for example `.slipmem/<id>.md`, and the destination is the direct child
  `<id>.md`. `check` resolves only direct children of the flat root, so a
  destination such as `.slipmem/<id>.md` would be reported as unsafe.
- Source-code and documentation evidence uses readable Markdown links to
  `https://github.com/blntrsz/slipmem/blob/main/...`. No bare source path is
  presented as the only pointer.
- No wikilink syntax remains under `.slipmem/`, including the starter README.
- Every note remains within its type limit after the URL expansion. Permanent
  bodies stay at 2000 characters or fewer; literature bodies stay at 5000 or
  fewer.

## Commands and observed results

```sh
bun run slipmem -- new --type permanent --title "Domain: <name>" \
  --tag domain --tag <tag> < /tmp/opencode/domain-notes/<name>.md
env -u SLIPMEM_ACTOR SLIPMEM_EDITOR=/tmp/opencode/note-rewrites/replace-note.sh \
  SLIPMEM_REPLACEMENT=/tmp/opencode/note-rewrites/replacements/<id>.md \
  bun run slipmem -- edit <id> --json
bun run slipmem -- check --rebuild-index
bun run slipmem -- tags
bun run slipmem -- search "domain fleeting" --limit 10
bun run slipmem -- search "approval proposal" --limit 10
bun run slipmem -- wiki domain --mode extractive --limit 10 --json
```

Observed:

- `check --rebuild-index` reported 16 notes, 18 files scanned, 0 errors,
  0 index drift, and OK. The two warnings were the expected non-note
  `.slipmem/.gitignore` and `.slipmem/README.md`.
- The tags command counted `domain` 11, `architecture` 4, `lifecycle` 3,
  `security` 3, `source` 3, `storage` 3, `approval` 2, `coding-standards` 2,
  `effect` 2, and one each for `contracts`, `fleeting`, `foldkit`, `identity`,
  `index`, `layers`, `literature`, `operations`, `permanent`, `reliability`,
  `search`, `services`, `tags`, `web`, and `wiki`.
- `search "domain fleeting"` returned eight notes, led by the fleeting,
  literature, and permanent domain notes. `search "approval proposal"` returned
  five notes, led by the approvals note.
- `wiki domain --mode extractive --limit 10` cited ten notes by ID and
  `.slipmem/<filename>` path, including all eight new domain notes.
- A link audit counted 53 `main` GitHub links, 2 commit-pinned GitHub links, and
  18 inter-note Markdown links in `.slipmem/**`. Every `main` target is tracked,
  both `8094950` paths exist, and every note destination exists.
- The service cookbook code block was re-extracted unchanged at 1204
  characters and compiled with the workspace TypeScript 7.0.2. The runtime
  harness still printed `{"direct":"p:body:a","throughLayer":"p:body:b"}`.

## Interpretations and ambiguities

- "Use GitHub link instead of `[[ ]]`" was interpreted as GitHub-flavored
  Markdown links, not remote GitHub URLs for inter-note links. Remote URLs for
  notes would stop being local note references that `check`, backlinks, and the
  wiki can resolve. Labels keep the requested `.slipmem/<id>.md` path visible.
- "Each domain should have a separate file" was interpreted as one permanent
  documentation note per cohesive implemented domain. The note type remains
  independent of the subject domain, so a fleeting-notes document is permanent.
- The existing literature references were converted from repository-relative
  strings to commit-pinned GitHub URLs. This preserves the snapshot while
  making provenance directly readable; the commit pin, not the live branch,
  remains authoritative.
- The new files' `main` links will not resolve on GitHub until this work is
  pushed. Pushing was not part of this task. Verification used local tracked
  paths and the existing remote base, not a fetch of new files.
- Storage, architecture, service, UI, and trust-boundary details were not
  repeated in new domain notes because the existing six permanent notes already
  own them. The domain set adds focused coverage rather than a second copy.

## Deliberate exclusions

- No secrets, credentials, tokens, personal data, pending proposal contents,
  cache contents, or local state were copied into notes or this evidence.
- No generated wiki page was persisted as a note.
- No `.state/`, cache database, log, or temporary draft was committed.
