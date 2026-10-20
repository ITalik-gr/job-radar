CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`text` text,
	`budget` real,
	`currency` text,
	`deadline_at` integer,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer,
	`fit` integer,
	`status` text DEFAULT 'new' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_source_external_uq` ON `leads` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `leads_company_idx` ON `leads` (`company_id`);--> statement-breakpoint
CREATE INDEX `leads_deadline_idx` ON `leads` (`deadline_at`);--> statement-breakpoint
CREATE TABLE `saved_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`query` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_filters_name_uq` ON `saved_filters` (`name`);--> statement-breakpoint
CREATE TABLE `site_audits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`checked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`url` text NOT NULL,
	`https` integer,
	`mobile_ok` integer,
	`perf_score` integer,
	`lcp_ms` integer,
	`cms` text,
	`copyright_year` integer,
	`issues` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_audits_company_idx` ON `site_audits` (`company_id`,`checked_at`);--> statement-breakpoint
ALTER TABLE `companies` ADD `market` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `industry` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `address` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `hiring_devs` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `hiring_roles` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `hiring_seen_at` integer;--> statement-breakpoint
CREATE INDEX `companies_kind_idx` ON `companies` (`kind`);--> statement-breakpoint
CREATE INDEX `companies_market_idx` ON `companies` (`market`);--> statement-breakpoint
ALTER TABLE `outreach` ADD `lead_id` integer REFERENCES leads(id);--> statement-breakpoint
UPDATE `companies` SET `market` = CASE
	WHEN lower(trim(`country`)) IN ('ua', 'ukraine', 'україна') THEN 'ua'
	WHEN `country` IS NOT NULL AND trim(`country`) <> '' THEN 'intl'
	ELSE NULL
END;--> statement-breakpoint
UPDATE `companies` SET
	`hiring_devs` = 1,
	`hiring_roles` = (SELECT count(*) FROM `vacancies` v WHERE v.`company_id` = `companies`.`id` AND v.`closed_at` IS NULL AND coalesce(v.`score`, 0) > -100 AND coalesce(v.`is_vacancy`, 1) = 1),
	`hiring_seen_at` = (SELECT max(v.`last_seen`) FROM `vacancies` v WHERE v.`company_id` = `companies`.`id` AND v.`closed_at` IS NULL AND coalesce(v.`score`, 0) > -100 AND coalesce(v.`is_vacancy`, 1) = 1)
WHERE EXISTS (SELECT 1 FROM `vacancies` v WHERE v.`company_id` = `companies`.`id` AND v.`closed_at` IS NULL AND coalesce(v.`score`, 0) > -100 AND coalesce(v.`is_vacancy`, 1) = 1);--> statement-breakpoint
UPDATE `templates` SET `body` = replace(`body`, '{{intro}}', coalesce(`intro`, '')) WHERE `body` LIKE '%{{intro}}%';--> statement-breakpoint
UPDATE `templates` SET `kind` = 'studio' WHERE `kind` = 'vacancy';--> statement-breakpoint
UPDATE `templates` SET `target_type` = NULL WHERE `target_type` = 'vacancy';
