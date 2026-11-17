# SQLite migration review fixes

Date: 2026-11-18

Scope: the verified migration audit findings against the SQLite-to-Markdown
planner and importer. Changes are limited to
`packages/core/src/migration/**`, `packages/core/src/markdown/lock.ts`,
`packages/core/src/markdown/root.ts`, the additive core export, and the
migration evidence document. `repository.ts`, the CLI, and the other Markdown
modules were not changed.

## Findings and fixes

### 1. Exact SQLite integers and blobs

Before: SQLite INTEGER values were read as JavaScript numbers, so values such as
`9223372036854775807` were rounded before appearing in extra-column preservation
or quarantine. INTEGER timestamps also assumed a number.

Now: every migration read uses `safeIntegers: true`. Extra and quarantine
columns keep bigints, and canonical hashes/manifest JSON encode them as
`{"$bigint":"..."}`. BLOBs are copied as base64-tagged values. Timestamps accept
REAL numbers and INTEGER bigints; a bigint outside the safe range is reported as
an invalid timestamp instead of being rounded.

Tests: `migration-plan.test.ts` "preserves integers above 2^53 and blobs
exactly"; `migration-import.test.ts` "preserves large integers and blobs in
notes and quarantine".

### 2. Live locks are never stolen by age

Before: a lock older than 30 seconds was deleted even when its owner PID was
alive, so a valid 79-second import could be stolen.

Now: a lock is stale only when its owner is dead, or when a reused PID no longer
matches the recorded Linux process start time and its heartbeat has lapsed. A
live matching owner is never evicted by age alone. Owners refresh the lock mtime
as a heartbeat, and release clears it. Dead stale locks are still recovered.

Tests: `lock.test.ts` covers an aged live-owner lock, heartbeat refresh across
the stale threshold, dead-owner recovery, and PID-reuse recovery. No test waits
30 seconds.

### 3. WAL planning without touching the source

Before: opening the source read-only could create or modify a `-shm` file next
to it, and a copied db+WAL without `-shm` or a read-only source directory failed.

Now: the planner and the backup copy the main database plus `-wal`/`-journal`
into a private temporary directory, verify every copy against the source hash,
read only the copy, and re-check the source fingerprints before returning. The
temporary copy is always removed. Dry runs write nothing beside the source or
target. WAL-only rows are visible, no `-shm` is created beside the source, and
read-only source directories work.

Tests: `migration-plan.test.ts` plans WAL-only rows from a copied db+WAL in a
read-only directory and asserts the directory is unchanged; `migration-import
.test.ts` runs a WAL dry run on a copied db+WAL without `-shm`.

### 4. Local state cannot escape through symlinks

Before: `ensureStateDirectory` used recursive `mkdir`, which followed a
symlinked `.state/` and let lock, manifest, and quarantine writes escape the
repository.

Now: `ensureStateDirectory` rejects a symlinked or escaping `.state/` and
`initializeNoteRoot` propagates the typed `symlink` error. A new
`ensureStateSubdirectory` rejects symlinked internal children such as
`.state/migrations/` and accepts only single safe path segments. The importer
uses it for the migrations, run, and quarantine directories.

Tests: `state-safety.test.ts` covers a symlinked `.state/`, a symlinked
`.state/migrations/`, initialization, and two importer aborts that leave the
outside directory empty.

### 5. Interrupted runs are detected and recoverable

Before: a process that died after writing a `running` manifest left that status
forever; a rerun did not report it.

Now: manifests record the owner PID. After taking the lock, a real import scans
older run directories and marks a `running` manifest `interrupted` (with
`interruptedAt` and `interruptedByRunId`) when the owner is gone. A live owner is
reported as `interrupted-run-active` and is never overwritten. Merge mode then
imports only missing `legacyId` rows, reusing notes from the interrupted run.

Tests: `migration-import.test.ts` marks a dead-owner manifest and merges the
remaining notes, and verifies that a live-owner manifest stays `running`.

### 6. Truthful skipped paths and collisions

Before: a skipped planned note kept a non-existent `-2` target path, and the
report counted planner collisions caused only by already-imported notes.

Now: a skipped result points at the actual existing file through `filename`,
`targetPath`, and `existingPath`, with the original planned name in
`plannedFilename`. `counts.collisions` is the effective count for this run and
does not count collisions that disappear because the same `legacyId` was already
imported. The plan keeps its original planner-level collision list and count.

Test: the merge idempotence test now asserts actual target paths, that those
files exist, and zero effective collisions on a clean rerun.

### 7. No false success and no silent table-shape loss

Before: rows in a table missing required columns were reported only at table
level, so their content was not quarantined. A verification report that had not
run claimed `ok: true`, which the CLI could print as success. The importer
created a root without a `.gitignore`.

Now:

- Every row of an incompatible table becomes an error-severity issue with its
  complete raw row, so the existing quarantine path preserves it. The run fails
  with `invalid-rows` rather than silently skipping the table.
- `verification.ok` is true only when `verified` is true. Dry runs and failures
  before verification report `verified: false, ok: false`.
- When the importer creates a root, it writes `.gitignore` with `.state/`. An
  existing `.gitignore` is never overwritten, and a write failure is a warning.

Tests: `migration-plan.test.ts` and `migration-import.test.ts` preserve an
incompatible table row in quarantine; the dry-run and pre-verification failure
reports assert `verification.ok === false`; the importer test checks the new
`.gitignore` and that an existing user `.gitignore` is byte-identical.

## Verification

```text
$ bun test packages/core/src/migration
 28 pass
 0 fail
 354 expect() calls
Ran 28 tests across 2 files.

$ bun test packages/core/src/markdown/lock.test.ts \
    packages/core/src/markdown/state-safety.test.ts
 9 pass
 0 fail
 23 expect() calls
Ran 9 tests across 2 files.

$ bun test packages/cli/src/migrate.test.ts
 4 pass
 0 fail
 46 expect() calls
Ran 4 tests across 1 file.
```

Scoped lint and typecheck for the changed files are clean. The full
`bun run check` passes at handoff: lint, typecheck, 335 tests, and the web build.

## Remaining caveats

- CLI presentation of `interruptedRuns` and `verification.verified` is a follow-
  up outside this change; the report data is available but the CLI is owned by
  another worker.
- A hot rollback journal is copied and replayed only if the staged read can
  recover it. Otherwise planning fails with a typed source error and no data is
  lost; WAL is the tested path.
- PID-reuse detection uses `/proc/<pid>/stat` on Linux. On other platforms the
  guard falls back to live-PID plus heartbeat, so a reused PID with a live
  unrelated process may leave a stale manifest unmarked (reported, not
  overwritten).
- The planner still reports its original collision list in `plan.collisions`;
  the run-effective value is `report.counts.collisions`.
