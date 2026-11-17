# Phase 0 Markdown contract verification

Date: 2026-11-17
Status: focused schema and fixture verification complete.

This note records the independent-review fixes to the Phase 0 Markdown contract
schemas and acceptance fixtures. It is evidence for the reviewer, not a second
contract: `packages/schemas/src/markdown.ts` remains the single definition.

## Files changed

- `packages/schemas/src/markdown.ts`
- `packages/schemas/src/markdown.test.ts`
- `packages/core/fixtures/phase0/acceptance/examples.json`
- `packages/core/src/markdown/phase0-fixtures.test.ts` (acceptance-payload
  validation only)
- `docs/mvp-contract-verification.md` (this file)

`docs/mvp-implementation-log.md` is owned elsewhere and was not edited.

## Audit findings and resolutions

| Finding | Resolution |
| --- | --- |
| `ApprovalProposal` made target, base, and content optional for every operation | `ApprovalProposal` is now an operation-discriminated union. Every variant requires `noteId` and `path`; `create` requires `content`; `update` and `reclassify` require `baseHash` plus `content`; `delete` requires `baseHash` and has no `content` field. `expiresAt` cannot precede `createdAt`. |
| `WikiSection` allowed uncited prose and blank citation paths | Sections require non-blank `heading` and `markdown` plus at least one citation. Citations require a non-blank `path`; a supplied excerpt must be non-blank. |
| `WikiPage.noteCount` accepted negatives | `noteCount` is an integer from `0` through `MAX_WIKI_LIMIT` (25). |
| `WikiInput` limits were unbounded | `limit` is an integer from `1` through `MAX_WIKI_LIMIT`. The topic keeps the kebab-case shape and the 64-character limit. |
| UTC timestamps accepted impossible dates | `Timestamp` now validates a real calendar instant through the same UTC prefix parser used by filenames, rejecting values such as `2026-02-30T19:30:45Z`, `2026-13-01T00:00:00Z`, and `2026-11-17T24:00:00Z`. |
| Note IDs accepted impossible timestamp prefixes | `NoteId` now requires a real UTC date/time in its 14-digit prefix. |
| `updatedAt` could be earlier than `createdAt` | `NoteMetadata` rejects `updatedAt < createdAt`; equality is allowed. |
| Literature metadata could omit or blank `reference` | `NoteMetadata` requires a non-blank `reference` when `type` is `literature`. A `reference` present on any type must be non-blank. |
| `TopicSlug` ignored the 64-character limit | `TopicSlug` enforces `MAX_TOPIC_LENGTH` (64) after the kebab-case pattern. |
| Acceptance wiki payloads did not match the schema | The API and MCP wiki examples now carry full `WikiPage` payloads: `generatedAt`, `sources`, cited `sections` with citation paths, and rendered `markdown`. |

## Exported shape changes to integrate

All previously exported names remain available. The following types became
stricter, so consumers that construct values must supply the new required
fields:

- `Markdown.ApprovalProposal` is now a discriminated union over `operation`.
  `noteId` and `path` are required on every variant. Check the operation before
  reading `baseHash` or `content`. Create still permits an optional `baseHash`
  and requires `content`; delete requires `baseHash` and has no `content` field.
- `Markdown.NoteMetadata` retains its struct shape, but decoding now rejects
  literature notes without a non-blank `reference` and notes whose `updatedAt`
  precedes `createdAt`.
- `Markdown.WikiSection` requires at least one citation and non-blank heading
  and markdown.
- `Markdown.WikiInput.limit` and `Markdown.WikiPage.noteCount` are bounded.
- `Markdown.Timestamp` and `Markdown.NoteId` reject impossible dates.
- `Markdown.TopicSlug` rejects values longer than 64 characters.

New pure helpers, additive only:

- `Markdown.isUtcTimestamp(value)`
- `Markdown.isNoteIdWithRealTimestamp(value)`

`Markdown.isNoteFilename` and `Markdown.isNoteId` keep their previous
pattern-only behavior; the stricter real-date rule is in the schemas and the new
helpers so storage code can choose where to enforce it.

## Decode is not a serializer

Effect struct decoding strips unknown keys. `Markdown.NoteMetadata` therefore
validates known fields but must not be used to re-render frontmatter. The core
parser keeps the unknown mapping (`splitUnknownMetadata`) and
`renderNoteDocument` writes it back, satisfying STOR-07. A schema test asserts
that decoding a metadata object with an extra key succeeds while dropping that
key, documenting the boundary explicitly.

## Acceptance fixture validation

`packages/core/src/markdown/phase0-fixtures.test.ts` now decodes both the API and
MCP wiki acceptance payloads with `Markdown.WikiPage`. It also asserts that the
same schema rejects a section with an empty citation list, so the positive
result is not caused by a permissive page schema.

The MCP wiki result was previously a summary shape (`topic`, `mode`,
`noteCount`, flat `citations`) that could not be validated as a wiki page. It now
matches the canonical structured page shape used by the API.

## Verification evidence

Run from the repository root on 2026-11-17:

```text
$ bun test packages/schemas/src/markdown.test.ts
22 pass, 0 fail, 104 expect() calls

$ bun test packages/core/src/markdown/phase0-fixtures.test.ts
12 pass, 0 fail, 200 expect() calls

$ bun test packages/schemas packages/core/src/markdown
83 pass, 0 fail, 595 expect() calls (6 files)

$ bun test
153 pass, 0 fail, 991 expect() calls (16 files)

$ bun run typecheck
passed (root and web configs)

$ bun run lint
passed (oxlint packages)
```

Concurrent work was present in the tree during verification (CLI, search index,
note service). The results above are the state at the time of this note; rerun
the focused commands after merges.
