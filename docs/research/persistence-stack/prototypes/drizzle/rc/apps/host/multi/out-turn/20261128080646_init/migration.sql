CREATE TABLE `turns` (
	`id` integer PRIMARY KEY,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`prompt_uuid` text,
	CONSTRAINT "turns_state_check" CHECK("state" in ('queued','running','closing','completed','failed','interrupted'))
);
