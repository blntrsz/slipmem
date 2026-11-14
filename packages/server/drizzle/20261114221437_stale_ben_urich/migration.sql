ALTER TABLE `fleeting_note` ADD `scope` text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE `fleeting_note` ADD `provenance` text DEFAULT '{"source":"legacy"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `literature_note` ADD `scope` text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE `literature_note` ADD `provenance` text DEFAULT '{"source":"legacy"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `permanent_note` ADD `scope` text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE `permanent_note` ADD `provenance` text DEFAULT '{"source":"legacy"}' NOT NULL;--> statement-breakpoint
CREATE INDEX `fleeting_note_scope_updated_at_idx` ON `fleeting_note` (`scope`,`updated_at`);--> statement-breakpoint
CREATE INDEX `literature_note_scope_updated_at_idx` ON `literature_note` (`scope`,`updated_at`);--> statement-breakpoint
CREATE INDEX `permanent_note_scope_updated_at_idx` ON `permanent_note` (`scope`,`updated_at`);