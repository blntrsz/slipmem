# Tags rename and repository dogfooding plan

Status: handoff research. No source files, existing notes, or app/core code were
edited by this task. This document is the only change.

Snapshot: the tree was clean at `bd756ee` when inspection began. A concurrent
rename then landed as `2f64eb1` (core), `c81a737` (CLI), `6b51240` (MCP),
`3f854b8` (server API and web UI), and `8094950` (current docs and tour).
Historical evidence documents intentionally keep the vocabulary of their
commits. Treat overlapping work as another owner's work: do not revert it.
Re-read `git status` before editing.

## 1. Decision

Canonical term: **tag**.

- Frontmatter field: `tags`.
- User vocabulary: "tag", "tags", "tag page". Keep `wiki` as the name of the
  derived, cited page feature; only its subject changes from topic to tag.
- No users exist and `.slipmem/` does not exist yet, so the public rename can be
  radical. Do not add `--topic`, `/api/topics`, `list_topics`, or similar
  public aliases.
- Keep exactly one compatibility rule, already implemented in `2f64eb1`:
  frontmatter `topics` is read as a one-way legacy alias for `tags`, rewritten
  as `tags` on the next write, and rejected if a note contains both keys.
- The index is disposable. `2f64eb1` bumped `INDEX_SCHEMA_VERSION` to 3; an old
  cache is dropped and rebuilt. No index migration is needed.

Why not keep `topics` as a synonym: two names for one field doubles the
contract, test matrix, UI copy, and agent tool surface, and guarantees future
drift. The only compatibility worth retaining is reading old note files, which
is already isolated in the parser.

## 2. Contract inventory to rename

This is the full set observed at `bd756ee`. The runtime portion landed in
`2f64eb1..3f854b8`; keep this table as the review checklist for any missed
surface.

| Surface | Old name | Canonical name |
| --- | --- | --- |
| Frontmatter | `topics: []` | `tags: []` |
| Schema constants | `MAX_TOPIC_LENGTH`, `TOPIC_SLUG_PATTERN` | `MAX_TAG_LENGTH`, `TAG_SLUG_PATTERN` |
| Schema types/helpers | `TopicSlug`, `slugifyTopic`, `isTopicSlug` | `TagSlug`, `slugifyTag`, `isTagSlug` |
| Metadata | `NoteMetadata.topics` | `NoteMetadata.tags` |
| Wiki input/page | `WikiInput.topic`, `WikiPage.topic` | `.tag` |
| Core repository | `ListMarkdownNotesInput.topic`, create/update `.topics` | `.tag`, `.tags` |
| Core index | `TopicSummary`, `listTopics`, `ListTopicsInput`, `DEFAULT_TOPIC_LIMIT`, `MAX_TOPIC_LIMIT`, `topic` filter, `topics` column | `TagSummary`, `listTags`, `ListTagsInput`, `DEFAULT_TAG_LIMIT`, `MAX_TAG_LIMIT`, `tag`, `tags` |
| Errors | `invalid-topic`, field `topic`/`topics` | `invalid-tag`, field `tag`/`tags` |
| Wiki selection/render | `tag`-less `topic` selection, `# Topic: ...`, topic suggestions | tag selection, `# Tag: ...`, tag suggestions |
| CLI command | `slipmem topics` | `slipmem tags` |
| CLI options | `--topic`, `--topics` | `--tag` (repeatable; comma-separated values still accepted) |
| CLI JSON | `topics` fields | `tags` fields; filter field `tag` |
| CLI wiki | positional `wiki <topic>` | `wiki <tag>` |
| JSON API inventory | `GET /api/topics`, `ApiTopic.topic` | `GET /api/tags`, `ApiTag.tag` |
| JSON API list/search | `?topic=` | `?tag=` |
| JSON API bodies | `topics: []` | `tags: []` |
| JSON API wiki | `GET /api/wiki/:topic`, page `.topic` | `GET /api/wiki/:tag`, page `.tag` |
| API schemas | `ApiTopic` | `ApiTag` |
| MCP inventory | `list_topics`, `build_topic_wiki`, `Mcp.ListTopicsInput`, `Mcp.ListTopicsResult` | `list_tags`, `build_tag_wiki`, `Mcp.ListTagsInput`, `Mcp.ListTagsResult` |
| MCP inputs/results | list/search `topic`, create/update `topics`, summary `.topic`, `.topics` | `tag`, `tags` |
| MCP constants | `DEFAULT_TOPIC_LIST_LIMIT`, `MAX_TOPIC_LIST_LIMIT`, `MAX_TOPIC_EXAMPLES`, `boundedTopicLimit` | `_TAG_` equivalents |
| Web routes | `/topics`, `/wiki/:topic` | `/tags`, `/wiki/:tag` |
| Web route union | `AppRoute.Topics`, `Wiki.topic`, home query `topic` | `Tags`, `tag` |
| Web model/messages | `topics`, `topicsRequestId`, `LoadTopics`, `ClickedTopics`, `UpdatedTopics`, etc. | `tags`, `tagsRequestId`, `LoadTags`, `ClickedTags`, `UpdatedTags`, etc. |
| Web API client | `ApiTopic`, `listTopics`, `getWiki(topic)`, `ListNotesInput.topic` | `ApiTag`, `listTags`, `getWiki(tag)`, `tag` |
| Web copy | "Topics", "Topic:", "Open topic page" | "Tags", "Tag:", "Open tag page" |
| Wiki bound | `MAX_WIKI_TOPIC_CHARS` | `MAX_WIKI_TAG_CHARS` |
| Fixtures | `topics` frontmatter/manifest/acceptance examples | `tags`; legacy alias test remains |
| Current docs | README, package READMEs, operator guide, normative plan | tag terminology |
| Tour | tracked product-tour script/README copy and `Topics` selectors | `Tags` selectors/copy |

`scripts/tour/output/` is gitignored. Regenerate it only after the UI rename,
and do not commit generated captures.

## 3. Rename strategy and order

1. **Core contract** (landed as `2f64eb1`): schemas, parser/renderer, repository,
   index, wiki, errors, fixtures. Keep the frontmatter alias and both-keys
   rejection test.
2. **CLI** (landed as `c81a737`): replace `commands/topics.ts` with
   `commands/tags.ts`; update `new`, `list`, `search`, `edit`, `note-values`,
   `note-output`, `cli`, help, tests, and `packages/cli/README.md`. Accept both
   `--tag a --tag b` and `--tag a,b`; do not keep `--topic`.
3. **Server and MCP** (landed as `6b51240` and `3f854b8`): update routes,
   query/body fields, response fields, schemas, tool names, tool descriptions,
   tests, and both READMEs. Keep `/api/notes/:type` compatibility adapters out
   of this rename.
4. **Web** (landed as `3f854b8`): update route union/builders,
   model/messages/commands, API client, views, editor validation, tests, and
   README. Use `/tags` and `/wiki/:tag`.
5. **Current docs and tour script** (landed as `8094950`): update
   normative/current documentation.
   Do not mass-rewrite historical evidence snapshots; add one terminology note
   to the relevant release/evidence index instead, so old reports remain honest
   about the vocabulary at their commits.
6. **Verify before dogfooding**: run the full gate and smoke every surface. Do
   not create repository notes before the rename lands, or they will be written
   with the old field.
7. **Create notes**: initialize `.slipmem/` at the Git root and add the note set
   below in a separate commit. Do not mix note creation with source commits.

Suggested commit boundaries: core (landed), CLI, server+MCP, web, current docs,
dogfood notes, final verification. No mixed docs/source commit.

### Compatibility rules

- Frontmatter `topics` is accepted on read, emitted only as `tags`, and both
  keys together is a validation error. This is the only old-name path.
- No command, flag, route, query parameter, MCP tool, or UI alias is kept.
- If this ever ships to users before the rename is complete, add a one-release
  alias layer only then; do not pre-build it.
- Delete or rebuild old index caches. The version bump is the recovery path.

## 4. Repository state and dogfooding boundary

At inspection:

- `.slipmem/` is **absent**. There are no user notes to read, expose, or modify.
- `.slipmem` is **not ignored** by the root `.gitignore` (`git check-ignore`
  has no match). A future note root is intended to be Git-tracked.
- `slipmem init` creates `.slipmem/`, `.state/`, a starter `README.md`, and
  `.slipmem/.gitignore` containing exactly `.state/`
  (`packages/core/src/markdown/root.ts:209-258`).
- Notes, `.slipmem/README.md`, and `.slipmem/.gitignore` are tracked; `.state/`
  and caches are not. The search index lives outside the root under the XDG
  cache. Deletes go to the XDG trash/backup.
- Creation via the CLI records human provenance (`source: cli`, actor `user` or
  `SLIPMEM_ACTOR`). This satisfies the user's request to create notes through
  the direct human workflow. Do not use MCP permanent writes: they create
  pending proposals and write no note.

## 5. Recommended note set

Body limits: fleeting 1000, permanent 2000, literature 5000 plus a non-blank
`reference`. Tags must be lowercase kebab-case, at most 64 characters. The
targets below stay comfortably under the permanent limit.

| # | Type | Title | Tags | Target chars |
| --- | --- | --- | --- | --- |
| P1 | permanent | slipmem is local-first Markdown memory | `domain`, `architecture`, `storage` | 1200-1500 |
| P2 | permanent | Markdown files are the only source of truth | `architecture`, `storage`, `reliability` | 1400-1700 |
| P3 | permanent | Schemas define the cross-surface contract | `architecture`, `contracts`, `effect` | 1200-1500 |
| P4 | permanent | Creating a core service: Shape, factory, Live Layer | `coding-standards`, `effect`, `services`, `layers` | 1500-1900 |
| P5 | permanent | Engineering standards: typed failures, bounds, and boundary tests | `coding-standards`, `testing`, `security` | 1400-1800 |
| P6 | permanent | The local trust boundary is not authentication | `security`, `approval`, `domain` | 1200-1600 |
| L1 | literature | Source: MVP plan principles, architecture, and security | `source`, `architecture`, `domain` | 1500-2500 |
| L2 | literature | Source: operator guide storage and trust boundary | `source`, `security`, `operations` | 1500-2500 |

### Body briefs and evidence pointers

Use evidence paths as inline code (for example `` `README.md` ``), not Markdown
links. `check` only accepts internal links to direct note IDs or `.md` files in
the flat note root; a link to `../README.md` is unsafe or broken.

**P1 — Domain.** What slipmem is: one flat Markdown repository, three note
types, and three interfaces over the same files. Fleeting is a low-trust inbox;
permanent is durable memory and is approval-gated for agents; literature
requires a source reference. Tags are metadata, not folders. The index and tag
pages are derived and disposable. No secrets: files are plaintext. Evidence:
`README.md:3-7`, `README.md:31-61`, `docs/mvp-plan.md:108-131`.

**P2 — Storage/architecture.** `.slipmem/` is the only source of truth. The
filename stem is the stable ID; type and tags live in frontmatter. Writes are
atomic, repository writes are locked, unknown frontmatter keys are preserved,
and the index, state, and trash stay outside the portable note set. The index
can be deleted and rebuilt. Evidence: `packages/core/src/markdown/paths.ts:28-63`,
`packages/core/src/markdown/atomic.ts:59-77`,
`packages/core/src/markdown/repository.ts:44-74`,
`packages/core/src/markdown/search-index.ts:30-38`,
`docs/operator-guide.md:33-102`.

**P3 — Contracts.** `@slipmem/schemas` owns executable constants, schemas,
slug normalization, filenames, metadata, approval proposals, and wiki output.
Core and surfaces import those rules instead of reimplementing them. The
`topics` -> `tags` rename is an example: one schema/parser/index change, then
surface adapters. Evidence: `packages/schemas/src/markdown.ts:3-22`,
`packages/schemas/src/markdown.ts:210-245`,
`packages/core/src/markdown/frontmatter.ts:290-360`,
`docs/mvp-plan.md:320-352`.

**P4 — Creating services.** The repeatable pattern: define a `Shape` interface
and `Context.Service`; build a pure `makeX` factory for tests and injectable
clock/env; expose `XLive` as `Layer.effect` over ambient dependencies; compose
the layer once per note root; keep surface code as adapters. Examples:
`WikiService` and `WikiServiceLive` (`packages/core/src/wiki/wiki-service.ts:68-88`,
`:158-180`, `:450-460`), `ApprovalService` (`packages/core/src/approval/approval-service.ts:181-184`,
`:1046-1056`), repository layer (`packages/core/src/markdown/repository.ts:515`,
`:796-800`), wiring (`packages/server/src/markdown.ts:25-59`,
`packages/mcp/src/layer.ts:10-34`).

**P5 — Standards/tests.** Failures are typed and actionable (`code`, `area`,
`path`, optional `field`), not stringly thrown defects. Every recall surface is
bounded. Tests use temporary note roots, a fixed clock, real files, and exact
error codes; fixtures freeze the storage contract. The full gate is lint,
typecheck, unit/integration tests, and the web build. Evidence:
`packages/core/src/markdown/errors.ts:3-60`,
`packages/core/src/markdown/repository.test.ts:1-75`,
`README.md:12-15`, `docs/mvp-plan.md:796-822`.

**P6 — Security.** Plaintext local files, loopback-by-default HTTP, no
authentication, same-origin JSON mutations, MCP approval for permanent writes
and deletes, note text treated as untrusted data, and synthesized wiki agents
sandboxed unless explicitly overridden. Approval is a local policy, not an OS
sandbox. Evidence: `README.md:71-90`, `packages/server/src/api.ts:280-325`,
`docs/operator-guide.md:793-849`, `docs/mvp-plan.md:796-822`.

**L1 — Literature.** Summarize the authoritative plan's principles, component
boundaries, data flow, topic-wiki rules, and security limits. Reference:
`docs/mvp-plan.md §4, §6, §9, §12 (repository commit bd756ee)`.

**L2 — Literature.** Summarize the operator-facing storage/trust boundary, MCP
approval policy, and local HTTP security posture. Reference:
`docs/operator-guide.md §2, §9, §10 (repository commit bd756ee)`.

Tag vocabulary stays small: `domain`, `architecture`, `storage`, `contracts`,
`effect`, `services`, `layers`, `coding-standards`, `testing`, `security`,
`approval`, `foldkit`, `mcp`, `web`, `source`, `operations`, `reliability`.
Do not create `topic` or `topics` tags.

## 6. Creation and verification workflow

After the rename is complete:

```sh
bun run slipmem -- init
bun run slipmem -- new --type permanent \
  --title "slipmem is local-first Markdown memory" \
  --tag domain --tag architecture --tag storage <<'EOF'
...body...
EOF
# Literature notes also need:
#   --reference 'docs/mvp-plan.md §4, §6, §9, §12 (repository commit bd756ee)'
bun run slipmem -- tags
bun run slipmem -- check --rebuild-index
bun run slipmem -- wiki architecture --mode extractive
bun run check
```

Also smoke `/api/tags`, `/api/wiki/architecture`, `/tags`, `/wiki/architecture`,
MCP `list_tags`, and MCP `build_tag_wiki`. Confirm a legacy `topics` note is
read, rewritten with `tags`, and that a note with both keys is rejected.

## 7. Ownership map and next parallel tasks

| Owner | Scope | Files | Depends on |
| --- | --- | --- | --- |
| Core/schemas | Landed `2f64eb1`; verify alias, index version, wiki tag fields | `packages/schemas/src/markdown*`, `packages/core/src/markdown/*`, `packages/core/src/wiki/*`, fixtures | done |
| CLI | Landed `c81a737`; verify `tags` command, `--tag`, help, JSON, tests | `packages/cli/src/commands/{tags,new,list,search,edit,wiki}.ts`, `cli.ts`, `note-values.ts`, `note-output.ts`, CLI tests, `packages/cli/README.md` | done |
| Server/MCP | Landed `6b51240`, `3f854b8`; verify routes, query/body/response, tool names/tests | `packages/server/src/api.ts`, `markdown.ts`, server tests, `packages/mcp/src/{schemas,tools,config}.ts`, MCP tests, both READMEs | done |
| Web | Landed `3f854b8`; verify `/tags`, `/wiki/:tag`, model/messages, API client, views/tests | `packages/web/src/{route,main,api}.ts`, web tests, `packages/web/README.md` | done |
| Docs/tour | Landed `8094950`; verify current docs and tracked tour script; historical evidence keeps old vocabulary | `README.md`, `docs/operator-guide.md`, `docs/mvp-plan.md`, current package READMEs, `scripts/tour/product-tour.script.json`, tour README | done |
| Dogfood curator | Initialize `.slipmem/`, create P1-P6 and L1-L2, verify check/wiki/tags | `.slipmem/` only | wait for docs/tour and verification |
| Verification | Full gate, API/MCP/CLI/web smoke, index rebuild, note check | no source ownership | docs/tour + dogfood |

Precise parallel split after core: CLI, server+MCP, and web can proceed
concurrently because each owns disjoint files. Docs/tour should start once route
and command names are fixed. Dogfood notes must wait for the CLI and frontmatter
field to land. Verification is last and should use a clean `git status` plus
`bun run check`.

## 8. Acceptance checklist

- [ ] Runtime/public surfaces contain no `topic` names; only the legacy
      frontmatter alias and historical evidence remain.
- [ ] `bun run check` passes.
- [ ] CLI `tags`, `--tag`, `wiki <tag>` work and `topics`/`--topic` are gone.
- [ ] API `/api/tags`, `?tag=`, `tags` bodies, `/api/wiki/:tag` work.
- [ ] MCP `list_tags`, `build_tag_wiki`, `tag`/`tags` inputs and results work.
- [ ] Web `/tags` and `/wiki/:tag` render and link correctly.
- [ ] Index schema 3 rebuilds from an old cache.
- [ ] Legacy `topics` frontmatter is read once and rewritten as `tags`; both
      keys fail validation.
- [ ] `.slipmem/` notes are created through CLI provenance, pass `check`, and
      are committed separately from source changes.
- [ ] No secrets are added to notes or docs.
