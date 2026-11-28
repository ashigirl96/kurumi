CREATE TABLE `inbound_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`platform_message_id` text NOT NULL,
	`body` text NOT NULL,
	`turn_id` integer,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_messages_platform_message_id_unique` ON `inbound_messages` (`platform_message_id`);