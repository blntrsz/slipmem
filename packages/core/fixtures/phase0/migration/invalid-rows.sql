-- Structurally valid current tables with rows that the Markdown importer must
-- report rather than silently truncate, drop, or "repair".
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
VALUES ('invalid-blank-title', '   ', 'Text must be preserved.', 1794943845000, 1794943845000);

INSERT INTO `permanent_note` (`id`, `title`, `content`, `created_at`, `updated_at`)
VALUES ('invalid-blank-content', 'Blank content', '', 1794951000000, 1794951000000);

INSERT INTO `literature_note` (`id`, `title`, `content`, `reference`, `created_at`, `updated_at`)
VALUES (
  'invalid-blank-reference',
  'Blank reference',
  'A quote without a source.',
  '   ',
  1794946500000,
  1794946500000
);

INSERT INTO `fleeting_note` (`id`, `title`, `content`, `created_at`, `updated_at`)
VALUES ('invalid-time-order', 'Time order', 'Updated before created.', 1794943902000, 1794943845000);

INSERT INTO `permanent_note` (`id`, `title`, `content`, `created_at`, `updated_at`)
VALUES ('invalid-time-range', 'Time range', 'Timestamp outside the Date range.', 100000000000000000000.0, 100000000000000000000.0);
