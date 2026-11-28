CREATE TABLE `turns` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`prompt_uuid` text,
	CONSTRAINT "turns_state_check" CHECK("turns"."state" in ('queued','running','closing','completed','failed','interrupted'))
);
