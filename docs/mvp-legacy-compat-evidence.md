# MVP migration legacy-compatibility evidence

Date: 2026-11-18
Scope: `packages/core/src/migration/**`, plus the follow-up CLI wiring in
`packages/cli/src/commands/legacy.ts`. This note covers the G4/G5/G8 gaps in
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md). The core section
was written before the CLI commands landed; the follow-up is marked where it
belongs and does not change normal startup behavior.

Status summary:

- **Read-only legacy compatibility path:** implemented as an explicit opt-in
  core API and, since `56d009c`, as bounded `slipmem legacy list/show` CLI
  commands. Neither is normal startup and neither is a second source of truth.
- **Real migration-shape import:** committed test creates the source with the
  real server startup layer (`makeDatabaseLayer` -> `runMigrations`), seeds rows
  through the real SQLite note services, then imports and verifies every field.
- **Legacy bootstrap:** committed test adopts the existing handwritten
  bootstrap fixture through the same real startup layer, then imports it.
- **Duplicate legacy IDs across types:** merge deduplicates by
  `(type, legacyId)`, so the same ID in different note tables stays two stable
  notes and no longer reports a permanent conflict on every rerun.
- **Reporting fixes from `/tmp/opencode/mig2/RESULTS.md`:** checkpointed running
  manifests, recovery counts derived from existing target files, no rounded
  structured provenance copy for unsafe integers, and PID-start markers for
  interrupted-manifest detection. The synchronous heartbeat limitation is
  documented below rather than hidden.

## 1. Real startup database import (MIGRATE-01 / G5)

Test:
`packages/server/src/migration-current-database.test.ts`

What it does:

1. Calls `makeDatabaseLayer(databasePath)` from
   `packages/server/src/database.ts`. This is the same layer used by the
   servers: it runs `runMigrations`, which validates/adopts the legacy shape,
   runs the checked-in Drizzle migration, and asserts the post-migration schema.
2. Creates one fleeting, one permanent, and one literature note through
   `FleetingNoteService`, `PermanentNoteService`, and `LiteratureNoteService`
   (the real Drizzle-backed note services), including a real update so
   `updatedAt` differs from `createdAt`.
3. Asserts `__drizzle_migrations` has one row before importing, proving the
   source was not handcrafted SQL.
4. Imports with `importMigration` and verifies, per row:
   - `type`, `legacyId`, `title`, body, and literature `reference`
   - `createdAt`/`updatedAt` exactly as the service stored them, converted by
     the same `Markdown.toUtcTimestamp` rule the importer uses
   - `provenance: { source: "import" }` and `scope: "global"`
   - rendered file hash equals the reported expected/actual hash
   - source SHA-256 before/after is identical, and `sourceCheck.unchanged` is
     true
5. Runs `checkNoteRoot` on the target and reads every note back through the
   parser.
6. Cross-checks the read-only compatibility reader against the same database
   and asserts the source hash is still unchanged.

A second test executes the existing `packages/core/fixtures/phase0/migration/
legacy.sql` handwritten-bootstrap shape into a fresh database, runs the same
real startup layer to adopt it, then imports and verifies all three legacy rows
and timestamps.

This removes the previous "hand-written `current.sql` only" limitation for
MIGRATE-01. It is still not a sanitized real production database, so the matrix
should say "real startup-created database and real repository writes", not
"real user data".

Command:

```text
$ bun test packages/core/src/migration
41 pass, 0 fail, 547 expect() calls, 4 files
```

## 2. Read-only legacy database API (G4)

Module: `packages/core/src/migration/legacy-read.ts`
Exported from the core entry point (`@slipmem/core`).

This is the one-release compatibility path. It is deliberately **not** wired
into CLI/MCP/web/server startup, and it never becomes a second source of truth:
`.slipmem/*.md` remains authoritative. A caller must explicitly opt in.

### API

```ts
import {
  getLegacyNote,
  listLegacyNotes,
  type LegacyListOptions,
  type LegacyGetOptions,
} from "@slipmem/core"

const page = listLegacyNotes({
  databasePath: "/path/to/retired/slipmem.db",
  // type: "literature",          // optional; defaults to all three tables
  // limit: 25,                    // 1..100, default 25
  // offset: 0,                    // 0..100000, default 0
})

for (const row of page.rows) {
  // row.raw is the normalized source row, never truncated
  if (!row.valid) {
    console.warn(row.legacyId, row.problems)
    continue
  }
  console.log(row.type, row.legacyId, row.note?.title)
}

const one = getLegacyNote({
  databasePath: "/path/to/retired/slipmem.db",
  type: "literature",       // required: legacy IDs are only unique per table
  legacyId: "legacy-literature",
})

if (one.row === null) {
  console.log("No such legacy row")
} else if (one.row.valid) {
  console.log(one.row.note?.reference)
}
```

Report shape (both functions):

- `schema: 1`, `compatibility: "one-release-read-only"`, `readOnly: true`
- `source: { path, bytes, sha256 }` for the untouched main database
- `warnings`: always includes `read-only-one-release`; table-level codes are
  `unsupported-note-table`, `missing-required-column`, and
  `missing-note-table`. `missing-note-table` applies when `get` names a type
  with no table and when `list` is given an explicit `type`; an untyped `list`
  stays silent about a type that never existed in that database.
- list adds `type`, `offset`, `limit`, `total`, `rows`
- get adds `type`, `legacyId`, `row: LegacyReadRow | null`

Each row has:

- `type`, `table`, `rowIndex`, `legacyId`
- `raw`: normalized raw row values, including blobs/bigints without losing
  identity
- `valid`: true only when the planner would import the row
- `note`: mapped `title`, `body`, `reference`, original millisecond timestamps,
  whole-second ISO timestamps, `scope`, `provenance`, `preservation`, and
  `sourceRowHash`; `null` for invalid rows
- `problems`: the planner's exact warnings/errors for that row

Bounds and identity:

- `limit` is an integer from 1 to 100 (default 25); `offset` is 0 to 100000.
- `get` requires a note type and a non-empty legacy ID of at most 512
  characters.
- The same legacy ID in different tables is returned as distinct rows with
  distinct `type`/`table` identity.
- Ordering is stable by `id` within a type, then contract type order
  (fleeting, permanent, literature).
- Values that are not JSON-native (`bigint`, `Uint8Array`) remain typed in
  `raw`/`note`; a JSON CLI must tag them the way the migration manifest does.

### Read-only and WAL behavior

The reader uses `withMigrationSourceSnapshot`, the same snapshot used by the
planner:

1. Copy the main DB plus `-wal`/`-journal` into a private temp directory.
2. Hash and byte-check each copy.
3. Re-fingerprint the source before opening the copy.
4. Open only the copy with `readonly: true`, `safeIntegers: true`, and
   `PRAGMA query_only = ON`.
5. Re-fingerprint the source after the callback; delete the temp directory.

The source is never opened by SQLite, so a WAL source does not gain a `-shm`
beside it. No note root, manifest, quarantine, or source row is written. Tests
assert the source directory is unchanged and a copied WAL database stays
exactly `db + wal` with identical hashes.

### CLI wiring (landed in `56d009c`)

The core section above was written first; the CLI commands landed later in
`56d009c` and are the user-facing opt-in:

```text
slipmem legacy list [--db <path>] [--type fleeting|permanent|literature]
                    [--limit 25] [--offset 0] [--json]
slipmem legacy show [--db <path>] --type <type> --id <legacyId> [--json]
```

- Source resolution matches migration: explicit `--db`, then
  `SLIPMEM_DB_PATH`, then `$XDG_DATA_HOME/slipmem/slipmem.db` (falling back to
  `~/.local/share/slipmem/slipmem.db`).
- Both commands print the one-release/read-only warning on every response, do
  not resolve a note root, reject `--dir`, never import or repair rows, and
  never write into `.slipmem/`.
- List defaults to 25 rows and is hard-bounded at 100; `show` is a single-row
  read; JSON tags bigints and blobs the way the migration manifest does.
- Tests: `packages/cli/src/legacy.test.ts`, **3 pass, 0 fail, 35 expect()
  calls** (`bun test packages/cli/src/legacy.test.ts`).

This does not make the legacy database a startup dependency or a source of
truth. It remains an explicit read-only inspection path for one release.

## 3. Duplicate legacy ID across note types (G8)

`importMigration` previously built its merge lookup as
`Map<legacyId, ParsedMarkdownNote>`. When a fleeting row and a permanent row
shared an ID, the second planned note compared itself with the first note's
file, saw a type/title difference, and reported `skipped-conflict` forever.

The lookup key is now `(type, legacyId)`. Cross-type rows with the same ID are
independent notes; same-type rows still skip by `legacyId` and still report a
real content conflict.

Regression tests:

- `migration-import.test.ts`: "merge keeps the same legacyId distinct across
  note types" - first import writes two notes; merge rerun writes zero, skips
  two as `skipped-legacy-id`, reports zero effective collisions, emits no
  `legacy-id-conflict`, and leaves both files unchanged.
- `legacy-read.test.ts`: "keeps the same legacy ID distinct across note types" -
  `list` returns both, and `get` returns the correct body per type.

## 4. Low reporting fixes from `/tmp/opencode/mig2/RESULTS.md`

### 4.1 Interrupted-run written count

The running manifest is now checkpointed every 25 note writes
(`MIGRATION_MANIFEST_CHECKPOINT_NOTES`). A crash therefore leaves an accurate
imported status count at the last checkpoint instead of zero.

Recovery also derives the count from disk: for each `planned`/`imported` note
result, an existing `targetPath` is evidence of an atomic write. The reported
`notesWritten` is the larger of the checkpointed manifest count and the existing
target files, so a crash between checkpoints is not under-reported and an
operator removing a file after the crash does not erase the lower bound.

New regression: "recovers the written count from existing target files after a
crash" creates three target files with a running manifest whose statuses are all
`planned`, and expects `interruptedRuns[0].notesWritten === 3`.

### 4.2 Unsafe provenance precision

When a provenance JSON envelope contains an integer outside JavaScript's safe
range, `JSON.parse` has already rounded it. The importer now keeps the complete
exact raw provenance text in `legacyColumns.provenance` and **does not** write a
structured `legacyProvenance` copy, which would expose the rounded number beside
the exact text.

Regression: plan test asserts `provenanceExtras` is empty; importer test asserts
`legacyProvenance` is undefined, `legacyColumns.provenance` is the exact raw
string, and the warning explains that no rounded structured copy is written.

### 4.3 Synchronous heartbeat limitation

`importMigration` is intentionally synchronous and runs inside
`Effect.sync` under `withRepositoryLock`. Node/Bun timers cannot fire while that
synchronous loop runs, so the lock mtime heartbeat does **not** advance during a
long import. Do not describe the heartbeat as protecting long imports.

The safety property that still holds is ownership: the lock has a live PID and
Linux start time, and a live matching owner is never evicted because the file is
old. The manifest progress checkpoint is a separate mechanism and does not
touch the lock. Making the heartbeat effective requires an async import or an
explicit synchronous heartbeat/progress callback; this note records the gap
instead of claiming otherwise.

### 4.4 Interrupted-manifest PID reuse

Running manifests now record `pidStart` on Linux. Recovery treats a manifest as
active only when the PID is alive **and**, if both start times are readable,
they match. A dead run whose PID was reused is marked `interrupted` instead of
being reported as active forever.

Regression: "marks a running manifest whose PID was reused by a different
process" writes the current PID with a deliberately wrong `pidStart` and expects
the manifest to be marked interrupted. The test is Linux-only; elsewhere the
conservative PID-only behavior remains.

## 5. Evidence commands and honest limits

```text
$ bun test packages/core/src/migration
41 pass, 0 fail, 547 expect() calls, 4 files

$ bunx tsc --noEmit
clean

$ bunx oxlint packages/core/src/migration packages/core/src/index.ts
clean

$ bun test packages/cli/src/migrate.test.ts
6 pass, 0 fail, 91 expect() calls

$ bun test packages/cli/src/legacy.test.ts
3 pass, 0 fail, 35 expect() calls
```

One combined run with the CLI suite hit the known 5-second `migrate` test
timeout while other workers were editing; the focused rerun passed. That
provisional state is superseded: the clean-clone `bun run check` at `d1f3565`
passed 382 tests with one conditional Playwright skip, 0 fail
([`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md)).

Still not claimed:

- No committed sanitized production database fixture; MIGRATE-01 is proven
  against a real-startup-created source, the frozen bootstrap fixture, and the
  actual local three-row database migrated by the final check, not a real
  user's corpus.
- The compatibility path is opt-in read-only: core
  `getLegacyNote`/`listLegacyNotes` plus the bounded `slipmem legacy list/show`
  commands (`56d009c`). No MCP/web/server startup path reads the old database.
- The reader copies the source per call. That is deliberate for WAL safety and
  source preservation; it is not a high-throughput reporting API.
- Lock mtime heartbeat still cannot run during the synchronous import
  (section 4.3); ownership checks, not heartbeat age, protect the lock.
