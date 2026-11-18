# Tags verification defect fixes

Date: 2026-11-18

Follow-up to `docs/tags-verification.md`. That review found five defects and one
hardening observation. This document records the fixes, their regression tests,
and the final gate. Application code, tests, current docs, and this evidence
file are in scope. `.slipmem/**` and `docs/repository-memory-evidence.md` were
not edited.

## Fixes

### D1 - Web editor cannot remove every tag

Commit `c04d537` (`Normalize web tags once and send an explicit empty list`).

- `packages/web/src/main.ts` now builds every save payload through
  `draftFromForm`. It always sends a `tags` array, including `tags: []` when the
  field is blank, so an update clears tags instead of being read as "preserve".
- `Note.Draft` now models the optional `tags` array that the web adapter
  already sent, so the shared wire contract matches the payload.
- Creation behavior is unchanged: an empty form sends `tags: []` and creates a
  note with no tags.

Regression: `packages/web/src/main.test.ts` asserts that a blank form produces
`tags: []` and that a populated form produces the normalized array.

### D2 - Web validation and payload used different tag parsers

Commit `c04d537`.

- `parseFormTags` is the single parser used by both `formError` and
  `draftFromForm`. It trims segments and drops empty segments.
- Empty segments, including leading, repeated, and trailing commas, are
  accepted consistently with the CLI's `--tag` handling. No segment reaches the
  server as an empty tag.
- Regression tests cover `" agent-memory, retrieval, "`, an all-empty value, and
  the validated-but-formerly-rejected `browser, , test` shape.

### D3 - Search claimed to search tags but did not

Commit `4f1bfd5` (`Search tags in ranked FTS and linear fallback`).

- `Note.SearchField` now includes `tags`; the Markdown index adds it to the
  default search fields.
- Ranked FTS5 search matches the existing `notes_fts.tags` column with the
  index's existing tag weight (2).
- The bounded linear fallback scores parsed tag slugs with the same weight, so
  behavior matches when FTS5 is unavailable.
- The CLI help text ("titles, tags, and bodies") is now accurate.

Regressions:

- `packages/core/src/markdown/search-index.test.ts` proves a tag-only word
  matches a note whose title and body lack it, `fields: ["tags"]` works,
  `fields: ["title"]` does not search tags, and a query plus a non-matching
  `tag` filter returns no hits. The same tag-only and filter cases run against
  the linear fallback.
- `packages/cli/src/search.test.ts` proves tag-only search and exact tag-filter
  intersection through the CLI.

### D4 - The authoritative MVP plan still used the old vocabulary

Commit `7cbc446` (`Update the current MVP plan to canonical tags`).

`docs/mvp-plan.md` now uses canonical `tags` throughout: frontmatter examples
and the field table, derived-index fields, CLI commands and flags (`tags`,
`--tag`, `wiki <tag>`), MCP tools (`list_tags`, `build_tag_wiki`), web routes
(`/tags`, `/wiki/:tag`), JSON API routes (`/api/tags`, `/api/wiki/:tag`), wiki
selection rules, phase deliverables, acceptance criteria, open decisions, and
documentation tasks.

A dated terminology note near the top records the 2026-11-18 change and the one
remaining read-compatibility path: legacy `topics` frontmatter is read as
`tags` and rewritten on the next save. No old runtime alias was added.
Historical evidence documents retain their original vocabulary.

### D5 - `show` tag label alignment

Commit `ed982eb` (`Align the show tags label with adjacent metadata`).

`packages/cli/src/note-output.ts` pads `tags:` to the same value column as
`type:`, `reference:`, and the other labels. `packages/cli/src/notes.test.ts`
asserts the aligned output.

## Hardening - stale `topics` write input

Commit `33f1ff6` (`Reject legacy topics on API and MCP writes`).

Previously, a stale client that sent `topics` to a write surface received a
successful response while its tags were discarded.

- JSON API: both `POST /api/notes` and `PUT /api/notes/:id` now fail closed with
  status 400, code `invalid-field`, and an actionable message naming `tags`.
  The message also explains that legacy `topics` frontmatter is read-only
  compatibility for existing notes. Known optional fields are unchanged.
- MCP: every local write tool is marked strict, so excess properties such as
  `topics` are rejected by parameter decoding before a handler runs. Read tools
  keep their existing flexibility. Canonical `tags` inputs continue to work.
- No `topics` tool input, JSON field, CLI flag, API route, or public alias was
  added.

Regressions:

- `packages/server/src/app.test.ts` sends raw `topics` payloads to create and
  update, asserts the `invalid-field` response, verifies no note was created,
  and verifies an existing note's tags were not changed. A canonical write with
  `tags` still succeeds in the same test.
- `packages/mcp/src/tools.test.ts` calls `create_fleeting_note` with `topics`
  over the MCP contract, asserts an error naming `topics`, and verifies no note
  was created.

## Final gate

`bun run check` on the final tree:

```text
$ bun run lint && bun run typecheck && bun test && bun run web:build
388 pass
0 fail
3344 expect() calls
Ran 388 tests across 45 files. [150.69s]
vite build: client and SSR bundles built successfully
```

Lint, both TypeScript projects, all tests, and the web build passed.

## Residual note for the dogfooding owner

`.slipmem/20261118022818-source-mvp-plan-principles-architecture-and-security.md`
said the authoritative plan "uses the historical word 'topic'" at commit
`8094950`. After `7cbc446`, that sentence is stale: the current plan uses
`tags` and records `topics` only as a read-compatibility note. The note was not
edited because note ownership is separate; its owner should update the
commit/terminology sentence.
