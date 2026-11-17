-- Pre-Drizzle handwritten bootstrap shape. The column order and constraints
-- match packages/server/src/migrations.ts legacyNoteTables exactly.
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

INSERT INTO fleeting_note (id, title, content, created_at, updated_at)
VALUES ('legacy-fleeting', 'Legacy fleeting', 'Old inbox thought.', 1794943845000, 1794943902000);

INSERT INTO permanent_note (id, title, content, created_at, updated_at)
VALUES ('legacy-permanent', 'Legacy permanent', 'Old lasting idea.', 1794951000000, 1794951060000);

INSERT INTO literature_note (id, title, content, reference, created_at, updated_at)
VALUES (
  'legacy-literature',
  'Legacy literature',
  'Old source-backed quote.',
  'Legacy book',
  1794946500000,
  1794946560000
);
