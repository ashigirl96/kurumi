CREATE TABLE `inbound_messages` (
	`id` integer PRIMARY KEY,
	`platform_message_id` text NOT NULL UNIQUE,
	`body` text NOT NULL,
	`turn_id` integer,
	CONSTRAINT `fk_inbound_messages_turn_id_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`)
);
