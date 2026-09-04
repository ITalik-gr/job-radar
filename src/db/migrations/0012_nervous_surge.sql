CREATE TABLE `facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`text_uk` text NOT NULL,
	`text_en` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `facts_key_uq` ON `facts` (`key`);--> statement-breakpoint
CREATE TABLE `send_log` (
	`day` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outreach` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`vacancy_id` integer,
	`contact_id` integer,
	`channel` text NOT NULL,
	`sent_at` integer,
	`template_used` text,
	`template_id` integer,
	`language` text,
	`subject_final` text,
	`body_final` text,
	`ai_used` integer DEFAULT false NOT NULL,
	`ai_paragraph` text,
	`status` text DEFAULT 'sent' NOT NULL,
	`gmail_message_id` text,
	`gmail_thread_id` text,
	`queued_at` integer,
	`contact_name` text,
	`contact_email` text,
	`reply_at` integer,
	`reply_type` text,
	`bounce_type` text,
	`followup_of` integer,
	`followup_due_at` integer,
	`error` text,
	`note` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_outreach`("id", "company_id", "vacancy_id", "channel", "sent_at", "template_used", "status", "contact_name", "contact_email", "reply_at", "reply_type", "note") SELECT "id", "company_id", "vacancy_id", "channel", "sent_at", "template_used", 'sent', "contact_name", "contact_email", "reply_at", "reply_type", "note" FROM `outreach`;--> statement-breakpoint
DROP TABLE `outreach`;--> statement-breakpoint
ALTER TABLE `__new_outreach` RENAME TO `outreach`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outreach_company_idx` ON `outreach` (`company_id`);--> statement-breakpoint
CREATE INDEX `outreach_sent_idx` ON `outreach` (`sent_at`);--> statement-breakpoint
CREATE INDEX `outreach_status_idx` ON `outreach` (`status`);--> statement-breakpoint
CREATE INDEX `outreach_followup_idx` ON `outreach` (`followup_due_at`);--> statement-breakpoint
ALTER TABLE `templates` ADD `language` text DEFAULT 'uk' NOT NULL;--> statement-breakpoint
ALTER TABLE `templates` ADD `target_type` text;