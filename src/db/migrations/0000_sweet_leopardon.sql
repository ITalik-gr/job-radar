CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`country` text,
	`city` text,
	`size_hint` text,
	`sources` text DEFAULT '[]' NOT NULL,
	`careers_url` text,
	`careers_kind` text DEFAULT 'unknown' NOT NULL,
	`careers_slug` text,
	`tech_hints` text DEFAULT '[]' NOT NULL,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_checked` integer,
	`last_change_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_uq` ON `companies` (`domain`);--> statement-breakpoint
CREATE INDEX `companies_last_checked_idx` ON `companies` (`last_checked`);--> statement-breakpoint
CREATE TABLE `company_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`snoozed_until` integer,
	`reason` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_state_company_uq` ON `company_state` (`company_id`);--> statement-breakpoint
CREATE INDEX `company_state_status_idx` ON `company_state` (`status`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`name` text,
	`role` text,
	`email` text,
	`telegram` text,
	`x_handle` text,
	`linkedin` text,
	`source_url` text,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_company_idx` ON `contacts` (`company_id`);--> statement-breakpoint
CREATE TABLE `outreach` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`vacancy_id` integer,
	`channel` text NOT NULL,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`template_used` text,
	`reply_at` integer,
	`reply_type` text,
	`note` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `outreach_company_idx` ON `outreach` (`company_id`);--> statement-breakpoint
CREATE INDEX `outreach_sent_idx` ON `outreach` (`sent_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`source` text NOT NULL,
	`items_found` integer DEFAULT 0 NOT NULL,
	`items_new` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_source_started_idx` ON `runs` (`source`,`started_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`url` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`content_hash` text NOT NULL,
	`text_normalized` text NOT NULL,
	`block_hashes` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_company_fetched_idx` ON `snapshots` (`company_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `vacancies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`url` text NOT NULL,
	`title` text,
	`raw_text` text,
	`stack` text DEFAULT '[]' NOT NULL,
	`seniority` text,
	`remote` integer,
	`location` text,
	`salary_min` integer,
	`salary_max` integer,
	`currency` text,
	`english_level_required` text,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer,
	`llm_relevance` integer,
	`llm_why` text,
	`is_vacancy` integer,
	`needs_review` integer DEFAULT false NOT NULL,
	`score` real,
	`dedupe_key` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vacancies_dedupe_uq` ON `vacancies` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `vacancies_company_idx` ON `vacancies` (`company_id`);--> statement-breakpoint
CREATE INDEX `vacancies_score_idx` ON `vacancies` (`score`);--> statement-breakpoint
CREATE INDEX `vacancies_closed_idx` ON `vacancies` (`closed_at`);