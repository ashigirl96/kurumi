CREATE TABLE `inbound_messages` (
	`id` integer PRIMARY KEY,
	`turn_id` integer,
	CONSTRAINT `fk_inbound_messages_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`)
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY,
	`session_id` text NOT NULL
);
