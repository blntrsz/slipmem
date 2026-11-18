# MVP release verification

Date: 2026-11-18
Snapshot: `2cdf077` (documentation only). Verified source head: `d1f3565`
(`d1f35656069d53a9d8e6cf73a437468065ffcdcd`), tree
`551b740ee00335ae2878543e2bdf08e08c43905b`.
Status: **release-verified on `d1f3565`; the only commits after it are
documentation.** The canonical criterion record is
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
| G4 legacy read path | closed | core reader `f6627a4`, warning fix `e1b7192`; bounded `slipmem legacy list/show` in `56d009c`; [`docs/mvp-cli-evidence.md`](./mvp-cli-evidence.md) and [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md) |
| G5 real migration source | closed, narrowed | `c4e7aff`; source created through `makeDatabaseLayer`/`runMigrations` and real note services; the final check also migrated the actual local three-row database at `d1f3565`; no sanitized production dump |
| G6 synthesis validity | conservative | `c6d61c1`, `05d5191`; exact complete-paragraph extraction, not entailment |
| G7 browser D1-D4 | closed | `b6f3cfe`; `/tmp/opencode/browser-final-polish/REPORT.md` (21/21 checks, 36 focused tests); later `8af9e27` API/index wiring re-exercised at `d1f3565` |
| G8 duplicate legacy IDs | closed | `c1f3bf1`; `(type, legacyId)` merge identity; cross-type merge idempotence test |

## 2. Release gate: verified

Clean clone of `d1f3565`, no test-timeout override and no `bunfig.toml`:

```sh
git clone --no-local /home/dev/src/slipmem /tmp/opencode/release-final-d1f3565
cd /tmp/opencode/release-final-d1f3565
bun install --frozen-lockfile
bun run check
```

```text
bun install --frozen-lockfile: exit 0, 61 packages installed
bun run lint:                 clean
bun run typecheck:            clean (root and packages/web)
bun test:                     382 pass, 1 skip, 0 fail
                              3287 expect() calls
                              383 tests across 45 files in 138.58 s
bun run web:build:            Vite client and SSR build successful
bun run check:                exit 0, 148.83 s
```

The single skip is `scripts/tour/record.test.mjs`, which is skipped when
Playwright/Chromium is unavailable in the clone. It is not a failure, and this
is not a 383-passed run. The product tour recorded separately with Playwright
1.64.1/Chromium 1248 recorded **20 pass, 0 fail, 66 expect() calls** and supplies
the hydrated-browser evidence.

Full detail, including the install mode-bit caveat
(`packages/mcp/src/main.ts` `100644` -> `100755`, content unchanged) and the
unproven offline-isolation caveat, is in
[`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md).

Clean-clone quickstart and migration are verified at the same source head:

- new-user local loop with isolated XDG roots: init, three note types, list,
  show, bounded search, topics, extractive wiki, absent-topic handling,
  rejected literature-without-reference, and `check`;
- cache recovery: `cache clear` -> 0 indexed notes, 3 notes untouched;
  `check --rebuild-index` -> drift 0; identical list and search IDs;
- read-only legacy view over the actual local default database (three rows, one
  per type), source bytes and hash unchanged;
- migration dry run and import: 3/3 rows, backup verified, source SHA-256
  unchanged, no `-shm` created; imported notes readable through CLI, web API,
  and stdio/HTTP MCP;
- approval index refresh independently reproduced at `8af9e27`.

## 3. Focused historical verification at `56d009c`

Retained as commit-local checkpoints; the clean-clone gate above supersedes them
as release evidence.

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
  Web/API sources were unchanged through `e408e47`
  (`git diff b6f3cfe..e408e47 -- packages/web/src packages/server/src/api.ts`
  is empty). Later `8af9e27` changed approval/index wiring in
  `packages/server/src/markdown.ts` and `packages/server/src/api.ts`; the
  `d1f3565` final check re-exercised the HTTP API and MCP after that change.
- Migration recheck: `/tmp/opencode/mig2/RESULTS.md`; all seven acceptance
  areas pass. The low reporting caveats are addressed or documented in
  [`docs/mvp-legacy-compat-evidence.md`](./mvp-legacy-compat-evidence.md)
  section 4.
- Earlier migration adversarial run: `/tmp/opencode/mig/EVIDENCE.md`.
- Final independent clean-clone check:
  [`docs/mvp-final-check-evidence.md`](./mvp-final-check-evidence.md).

## 4. Product video

Final silent product tour, recorded at `e408e47`:

| Item | Value |
| --- | --- |
| Path (generated, gitignored) | `scripts/tour/output/slipmem-product-tour.mp4` |
| SHA-256 | `a429e44bf936f0f4f0ed394e0af8f3642f1338ab9863fa33536ab5f4d7cb96a0` |
| Bytes | 3,018,971 |
| Video | H.264 High, `yuv420p`, 1440x900, 25 fps, 107.96 s |
| Audio | none (0 audio streams); captions burned into the picture |
| Scenario | 6 real notes; HTTP MCP permanent proposal approved in the browser; postconditions verified |

The recording commit `e408e47` predates the later source commits `8af9e27`
(approval index refresh) and `24a5c39` (test timeouts). The media was not
rerendered. Evidence: [`docs/mvp-product-tour-evidence.md`](./mvp-product-tour-evidence.md).

## 5. Claims to avoid

- Do not call the gate "383 passed". It is 382 pass plus one conditional
  Playwright skip.
- Do not claim a sanitized production/user-data migration. The evidence covers
  real startup-created sources, the frozen legacy bootstrap fixture, and the
  actual local three-row test database.
- Do not claim semantic validation, factual correctness, or truth for
  synthesized prose. Only complete verbatim paragraph citation is proven.
- Do not claim enforced offline/network isolation. `unshare -n` is denied; no
  external calls were observed, but isolation is not proven.
- Do not use the focused `56d009c` counts as the full repository gate.
- Do not claim the video was recorded at `d1f3565`; it was recorded at
  `e408e47` and not rerendered after the approval-index and test-budget
  commits.
