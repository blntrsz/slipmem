# SQLite migration planning evidence

Date: 2026-11-17

Scope: a pure, read-only planner for the SQLite-to-Markdown migration described
in `docs/mvp-plan.md` section 11. The planner does not write target notes, write
a manifest, create a note root, back up the database, or cut over any runtime
path. Those remain importer/CLI work.

## Files

- `packages/core/src/migration/migration-plan.ts` - planner and exported types.
- `packages/core/src/migration/migration-plan.test.ts` - focused contract and
  source-safety tests.
- `packages/core/src/index.ts` - additive `@slipmem/core` exports.

## Exported API

From `@slipmem/core`:

- `planMigration(options): MigrationPlan`
- `MigrationSourceError` with `code` values `missing`, `not-a-file`,
  `unreadable`, and `changed`
- `MIGRATION_PLAN_SCHEMA`, `DEFAULT_MIGRATION_SCOPE`,
  `IMPORT_PROVENANCE_SOURCE`, `NOTE_TABLE_NAMES`
- Types: `MigrationPlan`, `MigrationPlanOptions`, `MigrationPlanCounts`,
  `MigrationPlanIssue`, `MigrationIssueProblem`, `MigrationIssueCode`,
  `MigrationIssueSeverity`, `MigrationRowSource`, `MigrationSourceInfo`,
  `MigrationSourceTable`, `MigrationSourceShape`, `MigrationTableShape`,
  `MigrationSourceErrorCode`, `PlannedMigrationNote`,
  `MigrationNotePreservation`, `MigrationFilenameCollision`, `NoteTableName`,
  `SqliteValue`, `PreservedValue`

`MigrationPlanOptions` accepts `databasePath`, an optional `noteRoot` used only
to compute proposed `targetPath` values (default `.slipmem`), and optional
`takenFilenames` for collision checks against an existing root.

Each `PlannedMigrationNote` carries:

- `metadata` - frozen `Markdown.NoteMetadata`, including `legacyId`;
- `body` - the source `content`, byte-for-byte;
- `filename` and `targetPath`;
- `preservation.scope`, `preservation.provenanceExtras`, and
  `preservation.columns` for scope, unknown provenance keys such as
  `externalId`, and unknown or malformed source columns;
- `sourceRowHash` and `contentHash` for source-to-target verification.

The plan also reports source shape and table columns, source/planned/malformed
counts by type, filename collisions, the complete raw row for every malformed
row, and a stable `hash` over the plan.

## Safety model

- The source file is opened with `new Database(path, { readonly: true })` and
  `PRAGMA query_only = ON`.
- The source file SHA-256 is computed before opening and after closing. A change
  raises `MigrationSourceError("changed")` and produces no plan.
- Planning writes nothing to the filesystem. It only computes each target path.
- A missing source is a typed error; an empty or table-less database is a valid
  empty plan.
- A note table with missing required columns is reported as a table-level issue
  and skipped. Rows are not silently reinterpreted.
- Malformed rows are excluded from `notes` but retained in `issues` with their
  complete raw row, including full title, content, reference, and timestamps.
  Content is never truncated, repaired, or trimmed.

## Mapping decisions

- `id` becomes `legacyId`; the Markdown ID is the collision-resolved filename
  stem from the frozen `Markdown.noteFilename` / `slugifyTitle` helpers.
- Table kind becomes `type`; `content` becomes the body; literature
  `reference` is preserved.
- Epoch milliseconds are converted through `Markdown.toUtcTimestamp`, so the
  filename prefix and ISO timestamps use whole UTC seconds. Fractional
  milliseconds are truncated, and same-second title collisions receive `-2`,
  `-3`, and so on without changing the prefix.
- Rows are sorted by creation time, then table, then legacy ID before filenames
  are assigned, making collision suffixes deterministic across runs.
- A missing source `scope` column becomes `global`. A valid scoped-memory
  `scope` column is preserved in `preservation.scope`.
- A missing source `provenance` column becomes `{ source: "import" }`. Valid
  JSON provenance maps known `source`/`actor` into frozen metadata and keeps
  unknown keys in `preservation.provenanceExtras`. Invalid scope/provenance
  values produce warnings, are retained raw under `preservation.columns`, and
  do not block importing the note text.
- Unknown source columns are retained in `preservation.columns`.
- Content over the per-type Markdown limit is a malformed row: the full text is
  retained in the issue report and no note is planned.

## Phase 0 fixtures

| Fixture | Result |
| --- | --- |
| `current.sql` | 3 source rows, 3 planned notes, 0 malformed, 0 collisions |
| `legacy.sql` | 3 source rows, 3 planned notes, 0 malformed, source shape `bootstrap` |
| `empty.sql` | 0 rows, 0 notes, 0 issues, source shape `empty` |
| `invalid-rows.sql` | 5 source rows, 0 planned notes, 5 malformed rows, all raw rows preserved |

Sample current-fixture mapping:

```text
current-fleeting   -> 20261117193045-current-fleeting.md   (fleeting)
current-literature -> 20261117201500-current-literature.md (literature, reference "Book, chapter 2")
current-permanent  -> 20261117213000-current-permanent.md  (permanent)
```

## Verification

Focused tests:

```text
$ bun test packages/core/src/migration/migration-plan.test.ts
 8 pass
 0 fail
 124 expect() calls
Ran 8 tests across 1 file.
```

Migration plus Phase 0 fixtures:

```text
$ bun test packages/core/src/migration/migration-plan.test.ts packages/core/src/markdown/phase0-fixtures.test.ts
 19 pass
 0 fail
 320 expect() calls
Ran 19 tests across 2 files.
```

Lint:

```text
$ bunx oxlint packages
(no findings)
```

Scoped typecheck for the planner and tests:

```text
$ bunx tsc --ignoreConfig --noEmit --target ESNext --module Preserve \
    --moduleResolution bundler --moduleDetection force \
    --allowImportingTsExtensions --strict --skipLibCheck --types bun \
    packages/core/src/migration/migration-plan.ts \
    packages/core/src/migration/migration-plan.test.ts
(no errors)
```

The root `bunx tsc --noEmit` run also compiles the concurrently developed
Markdown repository files. At the time of this evidence it reported errors in
`packages/core/src/markdown/check.ts` and
`packages/core/src/markdown/repository.ts` (Effect API type mismatches), not in
the migration module. Re-run the root typecheck after that work lands.

Tests explicitly assert the dry run leaves the database bytes unchanged, creates
no SQLite sidecar files, and does not create the configured target directory.

## Follow-up outside this change

- Persist a manifest under `.slipmem/.state/` and add the pre-import database
  backup.
- Write targets atomically, then re-read and verify counts and content hashes.
- Implement merge/idempotency checks by `legacyId`.
- Refuse a non-empty note root without `--merge`.
- Cut over CLI/MCP/web defaults from SQLite to Markdown.
