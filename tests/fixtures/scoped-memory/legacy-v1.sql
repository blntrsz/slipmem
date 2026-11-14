-- Pre-scope slipmem database in the frozen handwritten bootstrap shape.
-- Load this fixture only into an empty SQLite file. It intentionally has no
-- __drizzle_migrations table, so startup must validate and adopt it.
--
-- Timestamps are fixed so a migration test can compare exact values. Duplicate
-- titles and equal timestamps are deliberate: adoption must not reorder,
-- merge, or drop rows.

CREATE TABLE fleeting_note (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE permanent_note (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE literature_note (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reference TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

INSERT INTO fleeting_note (id, title, content, created_at, updated_at) VALUES
  ('legacy-fleeting-migration', 'Legacy migration note', 'Old rows must survive and become searchable.', 300, 400),
  ('legacy-fleeting-unicode', 'Legacy Café', 'Punctuation in old data: —; 100%.', 900, 1000);

INSERT INTO permanent_note (id, title, content, created_at, updated_at) VALUES
  ('legacy-permanent-search', 'Legacy search target', 'Chapter references stay attached after migration.', 500, 600),
  ('legacy-permanent-duplicate', 'Legacy search target', 'Duplicate title from before scopes.', 500, 600);

INSERT INTO literature_note (id, title, content, reference, created_at, updated_at) VALUES
  ('legacy-literature-source', 'Legacy source', 'A quote that must keep its source.', 'Legacy Book, chapter 3', 700, 800);
