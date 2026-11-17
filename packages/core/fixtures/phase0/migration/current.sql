-- Current SQLite note shape after the checked-in Drizzle init migration.
-- The note tables are the only migration source; __drizzle_migrations is not
-- note content and its exact shape is not part of the import contract.
CREATE TABLE `fleeting_note` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `created_at` real NOT NULL,
  `updated_at` real NOT NULL
);

CREATE TABLE `literature_note` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `reference` text NOT NULL,
  `created_at` real NOT NULL,
  `updated_at` real NOT NULL
);

CREATE TABLE `permanent_note` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `created_at` real NOT NULL,
  `updated_at` real NOT NULL
);

INSERT INTO `fleeting_note` (`id`, `title`, `content`, `created_at`, `updated_at`)
VALUES (
  'current-fleeting',
  'Current fleeting',
  'A current-schema fleeting note.',
  1794943845000,
  1794943902000
);

INSERT INTO `literature_note` (`id`, `title`, `content`, `reference`, `created_at`, `updated_at`)
VALUES (
  'current-literature',
  'Current literature',
  'A current-schema literature note.',
  'Book, chapter 2',
  1794946500000,
  1794946560000
);

INSERT INTO `permanent_note` (`id`, `title`, `content`, `created_at`, `updated_at`)
VALUES (
  'current-permanent',
  'Current permanent',
  'A current-schema permanent note.',
  1794951000000,
  1794951060000
);
