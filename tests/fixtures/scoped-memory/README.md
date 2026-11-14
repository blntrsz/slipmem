# Scoped-memory fixtures

These fixtures are intentionally contract-neutral. They describe notes, scopes,
queries, and a legacy database; they do not import or name a production API.

- `corpus.json` — deterministic notes across `global`, `project-alpha`, and
  `project-beta`. Duplicate titles, equal timestamps, unicode, punctuation, and
  title/content/reference-only matches are deliberate.
- `search-cases.json` — proposed search vectors. `expectedKeys` is exact only
  where ranking and tokenizer choices do not change the answer. `openQuestions`
  lists decisions that must come from the search contract before asserting more.
- `legacy-v1.sql` — a populated database in the frozen pre-Drizzle bootstrap
  shape. Load it into an empty file with `Database.exec`.
- `legacy-v1.manifest.json` — the exact rows and invariants a scope migration
  must preserve.

## Usage sketch

```ts
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const legacy = new Database(databasePath)
legacy.exec(
  readFileSync(
    resolve(
      import.meta.dir,
      "../../../tests/fixtures/scoped-memory/legacy-v1.sql",
    ),
    "utf8",
  ),
)
legacy.close()
```

The relative path above is from `packages/server/src`; adjust it for the test
file that loads the fixture.

Do not seed `corpus.json` through raw SQL. Use the agreed write operation so the
test exercises the same validation and indexing path as production callers. If
the contract generates ids instead of accepting fixture ids, keep a key to
generated-id map and assert through the map.

The authoritative test plan is
[`docs/acceptance/scoped-memory-search.md`](../../docs/acceptance/scoped-memory-search.md).
