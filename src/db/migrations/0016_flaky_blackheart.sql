PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'vacancy' NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`target_type` text,
	`for_kind` text,
	`subject` text,
	`intro` text,
	`body` text DEFAULT '' NOT NULL,
	`note` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_templates`("id", "slug", "name", "kind", "language", "target_type", "for_kind", "subject", "intro", "body", "note", "archived", "created_at", "updated_at") SELECT "id", "slug", "name", "kind", "language", "target_type", "for_kind", "subject", "intro", "body", "note", "archived", "created_at", "updated_at" FROM `templates`;--> statement-breakpoint
DROP TABLE `templates`;--> statement-breakpoint
ALTER TABLE `__new_templates` RENAME TO `templates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `templates_slug_uq` ON `templates` (`slug`);