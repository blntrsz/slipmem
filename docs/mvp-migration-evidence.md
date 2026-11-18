# SQLite migration evidence

Date: 2026-11-18

Scope: the SQLite-to-Markdown migration described in `docs/mvp-plan.md` section
11. The migration is split into a non-destructive planner and a real importer.

- The planner does not write target notes, create a note root, back up the
  database, or cut over any runtime path. It reads a private temporary copy of
  the source and sidecars.
- The importer consumes the planner, backs up the source, writes verified
  targets atomically, and keeps its manifests and invalid-row quarantine under
  `.state/`. `slipmem migrate sqlite` calls the importer; the runtime defaults
  still use Markdown only.

## Files

- `packages/core/src/migration/migration-plan.ts` - planner and exported types.
- `packages/core/src/migration/migration-source.ts` - private source snapshot,
  sidecar fingerprints, and typed source errors.
- `packages/core/src/migration/migration-plan.test.ts` - focused contract,
  WAL-copy, exact-integer, and source-safety tests.
- `packages/core/src/migration/migration-import.ts` - importer, backup,
  manifests, quarantine, interrupted-run recovery, and verification.
- `packages/core/src/migration/migration-import.test.ts` - real import,
  dry-run, merge, collision, malformed-row, WAL, interrupted-run, and failure
  tests.
- `packages/core/src/markdown/lock.ts` - live-owner guard and lock heartbeat.
- `packages/core/src/markdown/lock.test.ts` and
  `packages/core/src/markdown/state-safety.test.ts` - stale-lock and local-state
  symlink regressions.
- `packages/core/src/markdown/root.ts` - private `.state/` creation and
  non-destructive `.gitignore` handling.
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

## Importer API

From `@slipmem/core`:

- `importMigration(options): MigrationImportReport` - synchronous one-shot
  import, suitable for the CLI's local command path.
- `MigrationImportError` with `code`, `message`, `report`, and `cause`. Codes:
  `root-not-directory`, `root-not-empty`, `invalid-rows`, `serializer-invalid`,
  `write-failed`, `verification-failed`, `source-changed`, `backup-failed`,
  `state-write-failed`, `lock-failed`.
- `MigrationSourceError` still comes from the planner for a missing, unreadable,
  or changed source before import begins.
- `MIGRATION_IMPORT_SCHEMA`, `MIGRATION_STATE_SUBDIRECTORY`,
  `MIGRATION_MANIFEST_FILENAME`, `MIGRATION_BACKUP_FILENAME`,
  `MIGRATION_QUARANTINE_DIRECTORY`, `defaultMigrationNoteSerializer`.
- Types: `MigrationImportOptions`, `MigrationImportReport`,
  `MigrationImportStatus`, `MigrationImportErrorCode`,
  `MigrationImportedNote`, `MigrationImportedNoteStatus`,
  `MigrationInterruptedRun`, `MigrationVerificationReport`,
  `MigrationVerificationNote`, `MigrationSourceCheck`,
  `MigrationSourceFileFingerprint`, `MigrationBackupReport`,
  `MigrationQuarantineReport`, `MigrationQuarantineFile`,
  `MigrationImportCounts`, `MigrationImportWarning`, `MigrationRootReport`,
  `MigrationNoteSerializer`.

`MigrationImportOptions` accepts `databasePath`, optional `noteRoot` (default
`.slipmem`), `merge`, `dryRun`, an injectable `now`, and a narrow
`serializer` seam. The default serializer is the existing Markdown
`renderNoteDocument` + `parseMarkdownNote` pair, so the importer does not
duplicate the storage contract.

`MigrationImportReport` carries the complete `MigrationPlan`, root inspection,
source fingerprints before/after, backup details, note statuses, verification
results, `interruptedRuns`, importer warnings, counts, and `error`. A failed
import still attaches this report to `MigrationImportError.report`.

Each imported-note result also records its plan source row and, when an existing
note was reused, `plannedFilename` plus the actual `filename`, `targetPath`, and
`existingPath`.

## Importer behavior

### Dry run

`dryRun: true` only reads the source and the existing root. It creates no note
root, `.state/`, manifest, quarantine, or backup, and writes no note file. The
report includes proposed filenames, counts, collisions, malformed rows, and a
`merge-required` warning when the root is non-empty without `merge`. The
focused test asserts the temporary directory still contains only the source
database after a dry run.

Both planning and a real import read a private snapshot of the source database
and its `-wal`/`-journal` sidecars, copied into a temporary directory that is
always removed. No `-shm` or checkpoint is created beside the source, a copied
db+WAL without `-shm` is readable, and a source directory without write access
is supported. The planner and backup both verify every copied byte against the
source hash and re-check the source fingerprints before returning.

### Root policy and merge

A real import refuses a root that contains any entry other than `.state/` unless
`merge: true`. Refusal happens before the repository lock or `.state/` creation,
so no target write occurs. In merge mode:

- Existing valid notes are indexed by `legacyId`.
- A planned row whose `legacyId` already exists is skipped, not duplicated.
- If the existing note's type, title, timestamps, reference, or canonical body
  differs from the source row, it is reported as `skipped-conflict` with a
  `legacy-id-conflict` warning and is still not overwritten.
- Existing filenames are passed to the planner, so a new row whose proposed
  filename is taken receives the normal `-2`, `-3`, ... suffix. Existing files
  are never overwritten.
- A skipped row is reported with the actual existing `filename`, `targetPath`,
  `existingPath`, and its planned name in `plannedFilename`; it no longer points
  at a non-existent suffixed path.
- `counts.collisions` is the effective count for notes that were actually
  written or would be written. A planner collision that disappears because the
  same `legacyId` was already imported is not counted again. The plan keeps its
  original planner-level collision list and count.

Re-running the current fixture with `merge: true` writes zero notes, skips all
three by `legacyId`, reports zero effective collisions, and leaves every file
byte-identical.

When the importer creates a new note root, it writes a `.gitignore` containing
`.state/`. An existing `.gitignore` is never overwritten (and is not modified
for an existing root). A `.gitignore` write failure is reported as a warning and
does not fail or roll back the import.

### Source backup

Before writing any note, the importer creates
`.state/migrations/<run-id>/source-backup.db` from the private source snapshot
using `VACUUM INTO`. This is a logically consistent SQLite snapshot that
includes uncheckpointed WAL frames. A zero-byte source with no WAL is copied
byte-for-byte because SQLite refuses `VACUUM INTO` from a read-only empty
database.

The backup is then opened read-only (with exact integer reads) and checked with
`PRAGMA integrity_check` plus a row count for every recognized source table. A
failed backup stops the import before target writes and raises
`backup-failed`; a source that changes while the snapshot is copied raises
`source-changed`.

The source database's main file and `-wal` sidecar are fingerprinted before the
backup, after the backup, and after verification. `sourceCheck.unchanged` is
true only when the main hash still equals the planner hash and the WAL
presence/bytes/hash did not change. The WAL test keeps a writer open with
`wal_autocheckpoint = 0`; the note is visible through the backup and the source
main and WAL bytes are unchanged.

### Notes and verification

Valid rows are rendered through the existing serializer, re-parsed in memory,
and written with `atomicWriteFile` using create-only mode. No repository
function is modified. The rendered frontmatter also carries preservation data as
unknown keys:

- `scope` - the planner's compatibility scope, including `global`;
- `legacyProvenance` - unknown provenance envelope keys;
- `legacyColumns` - unknown or malformed source columns.

The shared serializer trims the body's outer whitespace and the shared parser
normalizes CR line endings. This is the Markdown contract's canonical body
behavior. The importer warns with `body-normalized` and records the exact source
body in `notes[].sourceBody` in the manifest when that normalization changes the
text. It never truncates the source row.

After writing, the importer:

1. Re-reads each target as raw text and compares its SHA-256 with the rendered
   content hash.
2. Re-parses each target through the Markdown parser and compares ID, type,
   title, timestamps, legacy ID, reference, body, and preserved unknown keys.
3. Compares note filenames before and after; the new-file set must equal the
   imported set, with no unexpected files.
4. Re-checks the existing skipped notes and the source/WAL fingerprints.
5. Fails with `verification-failed` and keeps the manifest and targets on disk
   if any check differs.

`verification.ok` is only true when a real verification pass ran and passed.
Dry runs and failures that stop before verification carry
`verified: false, ok: false`, so a CLI cannot mistake an unrun check for
success.

### Invalid rows and failure semantics

Invalid rows are excluded from the plan by the planner. The importer writes every
error-severity row to `quarantine/<table>-row-<index>-<legacy-id>.json` with the
complete `problems` array and the complete raw `row`. A `quarantine/index.json`
lists them. Text, blobs as base64, bigints as explicit tags, and blank strings
are preserved verbatim; nothing is trimmed or shortened.

Valid rows are imported and verified first. If the plan still has any
error-severity issue, the command then throws `MigrationImportError` with code
`invalid-rows`. The report, manifest, backup, quarantine, and any valid notes
remain. This makes the partial result inspectable without silently dropping the
bad rows. Table-level issues without a raw row stay in the manifest `issues`
array.

Rows from a note table with missing required columns are also preserved. The
planner emits one table-level issue plus one error-severity issue per row with
the complete raw row and row index, so the normal quarantine path writes each
row to disk. The run still fails with `invalid-rows`; the table shape is never
silently reinterpreted.

A dry run with invalid rows succeeds as a report (`status: "dry-run"`,
`ok: false`) and writes no quarantine. A real import is the only path that
creates migration state.

## State artifacts

Each real import gets a unique run directory:

```text
.slipmem/.state/migrations/<YYYYMMDDHHmmss>[-n]/
  manifest.json
  source-backup.db
  quarantine/
    index.json
    <table>-row-<index>-<legacy-id>.json
```

`manifest.json` records the run id, owner PID, root and merge mode, source info,
plan hash, plan counts, backup, final counts, note statuses and hashes, all plan
issues and raw rows, filename collisions, verification, source fingerprints,
warnings, and the failure error if any. It is written atomically before notes,
updated during the run, and finalized as `imported` or `failed`.

A process that dies mid-import leaves a `running` manifest. On the next real
import, after taking the repository lock, the importer scans older runs:

- a `running` manifest whose recorded PID is gone is rewritten to
  `interrupted`, with `interruptedAt` and `interruptedByRunId`, and appears in
  `report.interruptedRuns`;
- a `running` manifest whose PID is still alive is reported as
  `interrupted-run-active` and is not modified;
- merge mode then imports only missing `legacyId` rows, so notes written by the
  interrupted run are reused rather than duplicated.

A malformed or unreadable old manifest is ignored by the marking pass; the
normal plan and quarantine paths still protect note data.

## CLI wiring notes

- Resolve the target root once, then call `importMigration({ databasePath,
  noteRoot, dryRun, merge })`.
- `dryRun` is the `slipmem migrate sqlite --dry-run` path. Print the report's
  counts, collisions, malformed rows, and `merge-required` warning; exit
  non-zero only if the CLI chooses to treat planned invalid rows as a failed
  preview.
- Catch `MigrationSourceError` for a missing/unreadable/changed source and
  `MigrationImportError` for root, backup, write, verification, or invalid-row
  failures. Print `error.code`, `error.message`, `report.manifestPath`,
  `report.backup.path`, and `report.quarantine.directory`.
- A successful report exposes `counts.writtenNotes`, `counts.skippedNotes`,
  `counts.collisions` (effective for this run), `verification`,
  `interruptedRuns`, and `plan.hash`. The CLI does not need to re-plan or
  re-hash.
- Print `verification.ok` only with `verification.verified`; a false `ok` before
  verification means the check was not run, not that it failed.
- Never call the importer without an explicit `merge` flag when the report (or
  root inspection) says the root is non-empty.

## Safety model

- The source main file and its `-wal`/`-journal` sidecars are fingerprinted
  (existence, size, SHA-256), copied to a private temporary directory, verified
  byte-for-byte, and re-fingerprinted after use. A change raises
  `MigrationSourceError("changed")` and produces no plan; the temporary copy is
  always removed.
- Planning opens only the private copy with
  `new Database(path, { readonly: true, safeIntegers: true })` and
  `PRAGMA query_only = ON`. SQLite therefore never creates `-shm` beside the
  source, never checkpoints it, and never needs a writable source directory.
- `safeIntegers` is enabled for every migration read. SQLite INTEGER values
  above 2^53 are decoded as bigints and written to manifests, quarantine files,
  and preserved frontmatter as explicit `{"$bigint":"..."}` tags. BLOBs are
  preserved as `{"$base64":"..."}`. Timestamps accept both REAL numbers and
  INTEGER bigints; a bigint outside the safe range is reported as an invalid
  timestamp instead of being rounded.
- Planning writes nothing to the filesystem except the private temporary
  snapshot; it only computes each target path.
- A missing source is a typed error; an empty or table-less database is a valid
  empty plan.
- A note table with missing required columns is reported as a table-level issue,
  every one of its rows is preserved in `issues` and quarantine, and no row is
  silently reinterpreted.
- Malformed rows are excluded from `notes` but retained in `issues` with their
  complete raw row, including full title, content, reference, and timestamps.
  Content is never truncated, repaired, or trimmed.
- `.state/` and every internal state child are created with symlink checks. A
  symlinked `.state/` or `.state/migrations/` is a typed `symlink` error rather
  than a path that escapes the repository.
- The repository lock heartbeat refreshes the lock mtime, and a lock whose owner
  PID is alive and whose Linux process start time matches is never evicted by
  age. Dead owners, and live PIDs whose recorded start time shows reuse, are
  recovered once stale. A long import therefore cannot be stolen by a second
  process merely because it runs longer than the 30-second default threshold.

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
  do not block importing the note text. If a valid envelope contains an integer
  outside the safe range, the complete raw provenance text is also retained
  because `JSON.parse` cannot preserve that literal exactly.
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

Focused importer tests:

```text
$ bun test packages/core/src/migration/migration-import.test.ts
 18 pass
 0 fail
 213 expect() calls
Ran 18 tests across 1 file.
```

Planner plus importer:

```text
$ bun test packages/core/src/migration
 29 pass
 0 fail
 358 expect() calls
Ran 29 tests across 2 files.
```

Lock and local-state safety:

```text
$ bun test packages/core/src/markdown/lock.test.ts \
    packages/core/src/markdown/state-safety.test.ts
 9 pass
 0 fail
 23 expect() calls
Ran 9 tests across 2 files.
```

Scoped lint:

```text
$ bunx oxlint packages/core/src/migration packages/core/src/index.ts
(no findings)
```

Scoped typecheck for the planner, importer, and both test files:

```text
$ bunx tsc --ignoreConfig --noEmit --target ESNext --module Preserve \
    --moduleResolution bundler --moduleDetection force \
    --allowImportingTsExtensions --strict --skipLibCheck --types bun \
    packages/core/src/migration/migration-plan.ts \
    packages/core/src/migration/migration-source.ts \
    packages/core/src/migration/migration-plan.test.ts \
    packages/core/src/migration/migration-import.ts \
    packages/core/src/migration/migration-import.test.ts \
    packages/core/src/markdown/lock.ts \
    packages/core/src/markdown/lock.test.ts \
    packages/core/src/markdown/root.ts \
    packages/core/src/markdown/state-safety.test.ts
(no errors, exit 0)
```

Root check status: `bun run check` passed after the migration review fixes
(lint, typecheck, all tests, and the web build). At final handoff another
worker's uncommitted `packages/web` changes make the repository typecheck fail
outside the migration, lock, root, and CLI areas; the scoped checks below and
the full migration/CLI test suites still pass. Re-run the root check once that
concurrent web work lands.

The importer tests cover:

- every Phase 0 migration fixture, including the empty database;
- actual import, source bytes unchanged, source backup integrity and row counts;
- exact integers above 2^53 and blobs in preserved frontmatter and quarantine;
- WAL-only rows, a copied db+WAL without `-shm`, and a read-only source
  directory, with the source directory unchanged;
- uncheckpointed WAL backup and unchanged main/WAL bytes;
- `merge` idempotence by `legacyId`, actual skipped target paths, zero effective
  collisions on rerun, and a second manifest run;
- interrupted `running` manifests marked safely, a live-owner manifest left
  alone, and merge recovery of the remaining notes;
- scope, unknown provenance keys, and unknown source columns round-tripping
  through note frontmatter;
- non-empty-root refusal without `merge`, with no `.state/` or note writes;
- same-second filename collisions and a merge collision with an existing file;
- malformed rows with complete raw text in quarantine, valid-row import, and the
  `invalid-rows` failure report;
- rows from a table with missing required columns preserved in quarantine;
- a new root receiving `.state/` in `.gitignore` while an existing user
  `.gitignore` is untouched;
- injected parser tampering that fails verification while preserving the
  manifest and original target files.

The dry-run test asserts the source database is the only file in the working
directory afterward, the target root is never created, and no backup, manifest,
or quarantine exists. WAL dry-run and planning tests assert that a copied
db+WAL directory is unchanged and gains no `-shm`.

## Follow-up outside this change

- Wire `importMigration` and `planMigration` into `slipmem migrate sqlite` in
  the CLI, including flag validation and printed report summaries.
- Decide the operator-facing policy for partially failed imports: keep valid
  notes plus quarantine (current behavior) or require a clean plan before any
  write.
- Cut over CLI/MCP/web defaults from SQLite to Markdown after the importer is
  accepted on a representative database.
- Keep the untouched SQLite source as the rollback path for one release.
