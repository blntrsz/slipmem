# Phase 0 fixture corpus

These fixtures freeze the Markdown storage contract before the repository,
CLI, MCP, and web code are rewritten. They are inputs to later parser and
migration tests, not a second specification. `docs/mvp-plan.md` remains the
authority; this directory records the concrete examples.

## Layout

- `notes/valid/*.md` - notes that must parse into valid note metadata and a
  non-empty body. `notes.manifest.json` records the expected ID, type, title,
  timestamps, topics, reference, unknown keys, and body text.
- `notes/invalid/*.md` - one broken rule per file. The manifest names the failing
  area and a stable expectation code.
- `migration/*.sql` - current Drizzle shape, pre-Drizzle bootstrap shape, an
  empty database, and structurally valid tables with invalid rows.
- `migration/manifest.json` - expected table/row counts and sample SQLite ID to
  Markdown mappings.
- `acceptance/examples.json` - representative CLI argv, JSON API requests, and
  MCP tool arguments/results. MCP permanent and delete writes stay
  `pending_approval`.

## Rules

- Timestamps are fixed UTC values. Never replace them with `Date.now()`.
- Valid filenames use `YYYYMMDDHHmmss-<kebab-slug>.md`; the manifest ID is the
  filename stem.
- Invalid fixtures each fail exactly one named area so a parser test can assert
  a specific error without guessing.
- Collision fixtures keep the 14-digit prefix and add `-2` to the slug.
- Migration SQL must stay executable by `bun:sqlite`. It is intentionally small
  and read-only; no fixture starts a service or touches a real database.
- Updating a fixture means consciously updating the manifest and the assertions
  in `packages/core/src/markdown/phase0-fixtures.test.ts`.

## Contract helpers

`packages/schemas/src/markdown.ts` exports the executable rules used by the
fixtures and future storage code: filename and topic patterns, slug
normalization, UTC timestamp conversion, collision-aware filename generation,
note metadata, approval proposals, and structured wiki output.
