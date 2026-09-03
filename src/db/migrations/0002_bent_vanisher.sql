CREATE TABLE `queue_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`vacancy_id` integer NOT NULL,
	`position` integer NOT NULL,
	`score_at_pick` real,
	`decision` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_items_day_vacancy_uq` ON `queue_items` (`day`,`vacancy_id`);--> statement-breakpoint
CREATE INDEX `queue_items_day_idx` ON `queue_items` (`day`,`position`);