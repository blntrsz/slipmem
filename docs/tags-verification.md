# Tags rename independent verification

Date: 2026-11-18
Verifier: independent verification subagent (`verify-tags`)

Scope: the canonical `topics` -> `tags` rename landed in `2f64eb1` (core),
`c81a737` (CLI), `6b51240` (MCP), `3f854b8` (server API and web), and
`8094950` (docs and tour), plus the follow-up parser fix `1d5a7a4` that treats
`tags: null` as absent. No application, schema, test, or repository note was
edited by this task. This document is the only change.

## 1. Method and gate

- Source under test: `1d5a7a4`. The working tree also contained another
  owner's untracked `.slipmem/` notes and `docs/repository-memory-evidence.md`;
  they were excluded and not read or modified.
- Full gate was run in a throwaway copy at `/tmp/opencode/slipmem-final`
  (`tar` copy of the tracked tree, `.slipmem/` removed), with isolated
  `HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, and `TMPDIR`.
- Runtime probes used disposable note roots and independent XDG roots under
  `/tmp/opencode/`; no root notes or user cache/state were touched.
- Browser probes used the production `dist/` bundle built from this tree and
  Playwright 1.64.1 / Chromium 1248.

Result of `bun run check` at `1d5a7a4` in the isolated copy:

```text
384 pass
1 skip
0 fail
3296 expect() calls
Ran 385 tests across 45 files. [185.82s]
EXIT:0
```

Lint, typecheck, tests, and the web build all passed.

## 2. Verified behavior

All commands below run with `SLIPMEM_DIR` and the XDG variables pointed at a
temporary root. `slipmem` means `bun packages/cli/src/main.ts` from the
checkout.

### Canonical frontmatter and CLI writes

- `slipmem init`, then
  `printf 'body\n' | slipmem new --type permanent --title Alpha --tag domain --tag architecture`
  writes:

  ```yaml
  tags:
    - domain
    - architecture
  ```

  No `topics` key is emitted.
- `--tag testing,security` writes two tags, so comma-separated values still
  work.
- `--tag " Agent Memory " --tag Café` writes `agent-memory`, `cafe`.
  Duplicates (`--tag a --tag A --tag a`) collapse to `a`.
- `--topic`, `--topics`, and the `topics` command are gone. Each fails with
  exit 2: `Unknown option --topic`, or `Unknown command 'topics'`.

### `tags`, list, and search

- `slipmem tags` prints a `TAG / NOTES` table; `--json` returns
  `{ ok, root, count, index, tags: [{ tag, noteCount }] }`.
- `slipmem tags --query arch` returns only `architecture`; `--limit 1` is
  honored.
- `slipmem list --tag architecture` returns the tagged notes;
  `--tag Architecture` and `--tag " Architecture "` normalize; `--tag arch`
  returns no notes because filters are exact slugs, not substring searches.
- `slipmem search architecture --tag domain` returns only the note with both
  the text and the exact tag. Search tag filters normalize display case.

### Legacy frontmatter alias

A note containing only:

```yaml
topics:
  - agent-memory
  - architecture
reference: legacy reference
provenance: { source: manual, actor: user }
aliases: [old-name]
custom: keep-me
extra: { nested: true }
```

- reads as `tags: [agent-memory, architecture]` in `show --json` and in
  `list`/`tags`/API results;
- after `edit` rewrites the file with `tags:`, while preserving `reference`,
  `provenance`, `aliases`, `custom`, and the nested `extra` mapping;
- `tags: null` plus `topics: [...]` reads the legacy list and rewrites
  canonical `tags` (follow-up `1d5a7a4`);
- a note with both non-null `tags` and `topics` fails `check`, `show`, and the
  API with code `invalid-field`, field `tags`:

  ```text
  Frontmatter cannot contain both tags and the legacy topics key. Keep tags and remove topics.
  ```

- `check` exits 1 for the both-keys note and 0 after the legacy note is
  rewritten.

### Index schema 3 rebuild

1. Seeded notes and links, then ran `check --rebuild-index`. The index stored
   `schema=3`, six notes, the expected padded `tags` strings, six FTS rows, and
   two resolved link rows.
2. Forced an old-cache state by setting `meta.schema=2`, replacing every
   stored tag with `stale`, and deleting the `links` rows.
3. Ran `slipmem tags` (which refreshes the index). On open, the version mismatch
   dropped and rebuilt `notes`, `links`, and `notes_fts`.
4. The rebuilt database was back at `schema=3` with all six tags, six FTS rows,
   and both link/backlink rows restored. `search architecture --tag
   architecture` returned the expected hits afterward.

`check --rebuild-index --json` also reported the two backlinks to the linked
notes, with zero drift.

### JSON API

Against a real `makeApiHandler` served by `Bun.serve` on a temporary port:

- `GET /api/tags` returns `{ tags: [{ tag, noteCount, byType: { fleeting,
  literature, permanent } }] }`; `?q=arch` filters.
- `GET /api/notes?tag=architecture` filters and includes canonical `tags`;
  unknown tag `arch` returns `{ "notes": [] }`.
- `GET /api/search?q=architecture&tag=domain` filters by tag; unknown tag
  returns no results.
- `GET /api/wiki/architecture` and `GET /api/wiki/Architecture` both return a
  page whose `.tag` is `architecture`. Default selection excludes fleeting
  notes; `?includeFleeting=true` includes them.
- `POST /api/notes` with `tags: ["api","architecture"]` returns those tags;
  `PUT /api/notes/:id` with `tags: ["api-only"]` replaces them; `PUT` with
  `tags: []` clears them.
- `GET /api/topics` returns 404. No route or response field uses `topic`.

### Web UI

Production bundle on `127.0.0.1:3417`, real API, disposable root:

- `/tags` shows `Tags`, the architecture row `3 notes (1 fleeting, 1
  literature, 1 permanent)`, and links to `/wiki/architecture`,
  `/?tag=architecture`, and `/wiki/architecture?includeFleeting=true`.
- Clicking the tag opens `/wiki/architecture`, headed `Tag: architecture`,
  citing permanent and literature notes and excluding the fleeting note by
  default. `?includeFleeting=true` cites it.
- `/?tag=architecture` shows only the three architecture-tagged notes, labels
  the filter `Tag: architecture`, and excludes the note tagged `elsewhere`.
- `/topics` renders `Page not found` ("No route for /topics.").
- `/wiki/!!!` renders the validation message `A tag must normalize to a
  lowercase kebab-case slug.`
- No `topic` copy or `/topics` links appeared in the rendered tags, wiki, or
  filtered-home pages. The only console error was the deliberate 400 response
  for `/api/wiki/!!!`.

### MCP

Real stdio server (`packages/mcp/src/main.ts`) over JSON-RPC, and the production
HTTP `/mcp` endpoint:

- 18 tools; `list_tags` and `build_tag_wiki` are present, and no tool name or
  description contains `topic`.
- `list_tags` input is `{ query?, limit? }`; output is
  `{ tags: [{ tag, noteCount, examples: [{ id, type, title }] }] }`.
- `build_tag_wiki` input is `{ tag, limit?, mode?, includeFleeting? }`; output
  keys are `tag`, `generatedAt`, `mode`, `noteCount`, `sources`, `sections`,
  `markdown`, matching `Markdown.WikiPage`.
- Calls returned normalized `tag`, bounded examples, cited wiki sections, and
  `invalid-tag` for `tag: "!!!"`.
- `search_notes` and the per-type list tools filter by `tag`.
- `list_topics` is `-32602 Tool 'list_topics' not found`.
- HTTP MCP `tools/list` matched the stdio names and schemas.

### Old runtime names

`grep -rniE '\btopics?\b' packages/*/src --include='*.ts' | grep -v '\.test\.ts'`
returns only:

- `LEGACY_TAGS_KEY = "topics"` (`packages/core/src/markdown/frontmatter.ts`);
- `data.topics` passed to the alias parser and its migration comments
  (`packages/core/src/markdown/note-document.ts`);
- the `topics -> tags` index-version comment
  (`packages/core/src/markdown/search-index.ts`).

No CLI flag/command, API route/field, MCP tool/input, web route/view, or tour
selector advertises `topic`.

## 3. Defects

Count: **5 defects** (2 medium, 2 low, 1 trivial), plus one hardening
observation that is not a rename exposure.

### D1 (medium) - Web editor cannot remove all tags

Reproduction harness:

```sh
SLIPMEM_DIR=/tmp/opencode/tags-web-notes PORT=3417 HOST=127.0.0.1 \
  bun run web:serve
# then use http://127.0.0.1:3417/ and read tags back with:
curl -s http://127.0.0.1:3417/api/notes/<id> | jq '.note.tags'
```

Steps:

1. Start the built server against a disposable root.
2. Open an existing note with tags, for example
   `/notes/<id>/edit`.
3. Clear the `Tags (comma separated)` field and press **Save changes**.
4. Read the note back.

Observed: the save succeeds and navigates to the note, but the tags are still
present (`["architecture", "browser"]`) and the page still shows both tag
chips. No error is shown.

Cause: `SaveNote` omits `tags` entirely when the form is blank
(`packages/web/src/main.ts:278-280`). The repository treats `undefined` as
"preserve existing tags", so the update cannot clear them. The API does clear
tags when sent `tags: []` (`PUT /api/notes/:id` verified), so this is a web
adapter bug, not an API gap. CLI `edit` sends `tags: edited.metadata.tags ?? []`
and also clears correctly.

### D2 (low) - Web tag form accepts a list with an empty segment, then the API rejects it

Steps:

1. Open `/new?type=permanent`.
2. Fill Title and Content.
3. Set Tags to `browser, , test` (a trailing comma also reproduces this).
4. Press **Create note**.

Observed: client-side validation passes, then the request fails with
`Tag '' does not normalize to a usable slug. (tags)` and no note is created.

Cause: `formError` maps, trims, and filters empty segments
(`packages/web/src/main.ts:713-716`), so validation sees `["browser","test"]`.
`SaveNote` then re-splits the raw string without filtering
(`packages/web/src/main.ts:280`), so `["browser","","test"]` reaches the
server. The CLI filters empty `--tag` values, so this is web-only.

### D3 (low) - `search` help claims it searches tags, but it does not

Reproduction with a note whose tag is `domain` and whose title/body do not
contain that word:

```sh
printf 'Body without the tag word.\n' | slipmem new --type permanent \
  --title 'Tag only note' --tag domain
slipmem tags --query domain --json   # shows domain, noteCount 1
slipmem search domain --json         # count 0
```

`slipmem help search` says "Ranked, bounded search across note titles, tags, and
bodies." The FTS query only targets `title`, `body`, and `reference`
(`SEARCH_FIELDS` at `packages/core/src/markdown/search-index.ts:43-47` and
`ftsMatchExpression` at `:592-605`). The index stores tags and gives the FTS
column a bm25 weight, but that column is never matched. This is a help-text /
behavior mismatch (the `--tag` filter works); either remove "tags" from the
summary or include the tags column in search.

### D4 (medium) - The authoritative MVP plan was not renamed

`docs/mvp-plan.md` is still the old contract. It contains 46 lines
(case-insensitive) with `topic`/`topics`, including:

- canonical frontmatter example and field table (`:218`, `:240`);
- CLI commands and flags `topics`, `--topic`, `wiki <topic>` (`:384-389`);
- MCP tools `list_topics` and `build_topic_wiki` (`:414-415`);
- web routes `/topics`, `/wiki/:topic` and JSON API `/api/topics`,
  `/api/wiki/:topic` (`:441-442`, `:457-458`);
- wiki selection rules and `topics` membership (`:521-533`).

It was not touched by `8094950`
(`git log -1 -- docs/mvp-plan.md` still points at `d4c0aae`), even though
`docs/tags-dogfooding-plan.md:92-96` assigns `docs/mvp-plan.md` to the
"current docs" commit and the operator guide names it as authority
(`docs/operator-guide.md:7`). It is not an evidence snapshot, so the historical
vocabulary exception does not apply. Readers following the current authority
for the API, CLI, and MCP will use names that now fail.

Reproduce:

```sh
grep -ciE '\btopics?\b' docs/mvp-plan.md
grep -nE 'slipmem topics|--topic|/api/topics|list_topics|build_topic_wiki|/topics|wiki/:topic' docs/mvp-plan.md
```

### D5 (trivial) - `show` tag label is misaligned

`slipmem show <id>` prints `tags:    ...` while every neighbouring label aligns
to the same value column (`type:`, `reference:`). Renaming `topics:` to `tags:`
shortened the label without adjusting the padding
(`packages/cli/src/note-output.ts:20-21`). Cosmetic only.

## 4. Hardening observation (not counted as a defect)

MCP tool inputs and JSON API bodies accept unknown properties
(`additionalProperties: true` in generated tool schemas; `readCreateBody` reads
only known keys). A stale client that still sends `topics` therefore gets a
successful write with no tags instead of a validation error:

- `create_fleeting_note` with `{ title, content, topics: ["legacy"] }` creates
  a note with no `tags` and no `topics` frontmatter.
- `POST /api/notes` with a `topics` array behaves the same.

This is not an advertised old-name alias and no old name appears in a schema,
route, or tool list, so it does not violate the "no runtime public topic
exposure" boundary. It is still silent data loss for a stale caller; rejecting
unknown write fields (or accepting `topics` only as an explicit legacy
diagnostic) would be safer if backward compatibility ever matters.

## 5. Historical documents deliberately not counted

`docs/mvp-*-evidence.md`, `docs/mvp-implementation-log.md`, and
`docs/mvp-acceptance-matrix.md` record behavior at earlier commits and keep
their original vocabulary by design. `docs/tags-dogfooding-plan.md` also names
the old terms while describing the rename. These were excluded from the
defect list. `docs/mvp-plan.md` is excluded from that exception because it is
the living authority document, not evidence.
