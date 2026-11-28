PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turns` (
	`id` integer PRIMARY KEY,
	`session_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
INSERT INTO `__new_turns`(`id`, `session_id`) SELECT `id`, `session_id` FROM `turns`;--> statement-breakpoint
DROP TABLE `turns`;--> statement-breakpoint
ALTER TABLE `__new_turns` RENAME TO `turns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;