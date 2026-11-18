# MVP release verification

Date: 2026-11-18
Snapshot: `e408e47` (code and test runs at `56d009c`; `e408e47` is
documentation only)
Status: **not released.** The canonical criterion record is
[`docs/mvp-acceptance-matrix.md`](./mvp-acceptance-matrix.md); this note is the
short release gate and evidence index, not a second acceptance matrix.

## 1. Gap ledger

The plan gaps called out by the first matrix draft are closed or narrowed. G6
remains a deliberate conservative implementation rather than a semantic
guarantee:

| Gap | Status | Commit and evidence |
| --- | --- | --- |
| G1 clear-cache command | closed | `5002d7b`; `packages/cli/src/commands/cache.ts`, `packages/cli/src/cache.test.ts` |
| G2 indexed backlinks | closed | `77f4175`; schema v2 `links` table + bounded `backlinks` API; [`docs/mvp-backlink-index-evidence.md`](./mvp-backlink-index-evidence.md) |
| G3 migration source default | closed | `043de62`, `9d299fe`; `--db`, `SLIPMEM_DB_PATH`, XDG data; empty `--db` rejected |
| G4 legacy read path | closed | core reader `f6627a4`, warning fix `e1b7192`; bounded `slipmem legacy list/show` in `56d009c`; [`docs/mvp-cli-evidence.md`](./mvp-cli-evidence.md) and [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md) (core API section) |
| G5 real migration source | closed, narrowed | `c4e7aff`; source created through `makeDatabaseLayer`/`runMigrations` and real note services; no sanitized production dump |
| G6 synthesis validity | conservative | `c6d61c1`, `05d5191`; exact complete-paragraph extraction, not entailment |
| G7 browser D1-D4 | closed | `b6f3cfe`; `/tmp/opencode/browser-final-polish/REPORT.md` (21/21 checks, 36 focused tests) |
| G8 duplicate legacy IDs | closed | `c1f3bf1`; `(type, legacyId)` merge identity; cross-type merge idempotence test |

## 2. Focused verification at this snapshot

```text
$ bun test packages/core/src/migration
41 pass, 0 fail, 547 expect() calls, 4 files

$ bun test packages/core/src/markdown/search-index.test.ts packages/cli/src/cache.test.ts
22 pass, 0 fail, 124 expect() calls, 2 files

$ bun test packages/cli
52 pass, 0 fail, 453 expect() calls, 14 files

$ bun test packages/cli/src/legacy.test.ts
3 pass, 0 fail, 35 expect() calls, 1 file

$ bun test packages/core/src/wiki
33 pass, 0 fail, 237 expect() calls, 2 files
```

Independent evidence:

- Browser polish: `/tmp/opencode/browser-final-polish/REPORT.md` at `b6f3cfe`.
  Web/API sources are unchanged through `e408e47`
  (`git diff b6f3cfe..e408e47 -- packages/web/src packages/server/src/api.ts`
  is empty).
- Migration recheck: `/tmp/opencode/mig2/RESULTS.md`; all seven acceptance
  areas pass. The low reporting caveats are addressed or documented in
  [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md)
  section 4.
- Earlier migration adversarial run:
  `/tmp/opencode/mig/EVIDENCE.md`.

## 3. Release gate still open

1. **Full gate on the landed head.** Run `bun run check` (oxlint, root and web
   typecheck, full test suite, Vite client + SSR build). The last recorded green
   full gate is `370 pass / 0 fail / 3140 expect() calls / 44 files` in
   [`docs/mvp-backlink-index-evidence.md`](./mvp-backlink-index-evidence.md)
   section 6, before follow-up commits `043de62` through `e408e47`. Focused
   suites do not substitute for this.
2. **Clean-checkout quickstart.** Clone, `bun install`, `bun run check`,
   `slipmem init`, create/search/read, MCP handshake, and the web launch on the
   clean clone. A separate agent is running this verification; no result is
   recorded here yet.
3. **Product video.** The tour scaffold exists; the final recording is pending
   if it remains a release deliverable.

## 4. Claims to avoid

- Do not call the MVP fully complete before items 1 and 2 above are recorded.
- Do not claim a sanitized production/user-data migration. The evidence covers a
  real startup-created database and the frozen legacy bootstrap fixture.
- Do not claim semantic validation, factual correctness, or truth for
  synthesized prose. Only complete verbatim paragraph citation is proven.
- Do not use focused test counts as the full repository gate.
