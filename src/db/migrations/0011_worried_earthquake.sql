ALTER TABLE `companies` ADD `rating` real;--> statement-breakpoint
ALTER TABLE `companies` ADD `reviews_count` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `min_project` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `hourly_rate` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `founded_year` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `extra` text DEFAULT '{}' NOT NULL;