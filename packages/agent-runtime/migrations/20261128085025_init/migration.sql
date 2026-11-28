CREATE TABLE `inbound_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`channel` text NOT NULL,
	`conversation` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`sender` text NOT NULL,
	`body` text NOT NULL,
	`received_at` integer NOT NULL,
	`turn_id` integer,
	`answered_at` integer,
	`outcome` text,
	CONSTRAINT `fk_inbound_messages_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`),
	CONSTRAINT `inbound_messages_channel_platform_message_id_unique` UNIQUE(`channel`,`platform_message_id`),
	CONSTRAINT "inbound_messages_outcome_check" CHECK("outcome" in ('answered','interrupted','failed'))
);
--> statement-breakpoint
CREATE TABLE `outbound_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`turn_id` integer,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`idempotency_key` text NOT NULL UNIQUE,
	`state` text NOT NULL,
	CONSTRAINT "outbound_messages_kind_check" CHECK("kind" in ('final','progress','notice')),
	CONSTRAINT "outbound_messages_state_check" CHECK("state" in ('pending','sending','delivered'))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`conversation` text NOT NULL,
	`agent` text NOT NULL,
	`claude_session_id` text,
	`config_dir` text NOT NULL,
	`workspace_dir` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK("status" in ('active','lost'))
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`tool_use_id` text PRIMARY KEY,
	`turn_id` integer NOT NULL,
	`tool_name` text NOT NULL,
	`input_summary` text NOT NULL,
	`started_at` integer NOT NULL,
	CONSTRAINT `fk_tool_calls_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`)
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`end_reason` text,
	`prompt_uuid` text,
	`last_assistant_uuid` text,
	CONSTRAINT "turns_state_check" CHECK("state" in ('queued','running','closing','completed','failed','interrupted'))
);
