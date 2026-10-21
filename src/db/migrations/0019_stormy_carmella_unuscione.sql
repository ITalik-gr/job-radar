DROP INDEX `companies_domain_uq`;--> statement-breakpoint
ALTER TABLE `companies` ADD `registry_code` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `place_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `companies_registry_code_uq` ON `companies` (`registry_code`) WHERE registry_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `companies_place_id_uq` ON `companies` (`place_id`) WHERE place_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_uq` ON `companies` (`domain`) WHERE domain <> '';--> statement-breakpoint
ALTER TABLE `contacts` ADD `phone` text;--> statement-breakpoint
-- Country names to ISO alpha-2, the same map as COUNTRY_CODES in src/lib/normalize.ts.
UPDATE `companies` SET `country` = 'US' WHERE lower(`country`) IN ('usa', 'united states', 'united states of america', 'us');--> statement-breakpoint
UPDATE `companies` SET `country` = 'GB' WHERE lower(`country`) IN ('united kingdom', 'uk', 'great britain', 'england', 'gb');--> statement-breakpoint
UPDATE `companies` SET `country` = 'UA' WHERE lower(`country`) IN ('ukraine', 'ua') OR `country` IN ('Україна', 'Украина', 'україна', 'украина');--> statement-breakpoint
UPDATE `companies` SET `country` = 'IN' WHERE lower(`country`) IN ('india');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CA' WHERE lower(`country`) IN ('canada');--> statement-breakpoint
UPDATE `companies` SET `country` = 'DE' WHERE lower(`country`) IN ('germany');--> statement-breakpoint
UPDATE `companies` SET `country` = 'PL' WHERE lower(`country`) IN ('poland');--> statement-breakpoint
UPDATE `companies` SET `country` = 'FR' WHERE lower(`country`) IN ('france');--> statement-breakpoint
UPDATE `companies` SET `country` = 'SG' WHERE lower(`country`) IN ('singapore');--> statement-breakpoint
UPDATE `companies` SET `country` = 'MX' WHERE lower(`country`) IN ('mexico');--> statement-breakpoint
UPDATE `companies` SET `country` = 'AE' WHERE lower(`country`) IN ('united arab emirates', 'uae');--> statement-breakpoint
UPDATE `companies` SET `country` = 'SE' WHERE lower(`country`) IN ('sweden');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CH' WHERE lower(`country`) IN ('switzerland');--> statement-breakpoint
UPDATE `companies` SET `country` = 'BR' WHERE lower(`country`) IN ('brazil');--> statement-breakpoint
UPDATE `companies` SET `country` = 'AU' WHERE lower(`country`) IN ('australia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'VN' WHERE lower(`country`) IN ('vietnam');--> statement-breakpoint
UPDATE `companies` SET `country` = 'ES' WHERE lower(`country`) IN ('spain');--> statement-breakpoint
UPDATE `companies` SET `country` = 'IL' WHERE lower(`country`) IN ('israel');--> statement-breakpoint
UPDATE `companies` SET `country` = 'DK' WHERE lower(`country`) IN ('denmark');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CO' WHERE lower(`country`) IN ('colombia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'NO' WHERE lower(`country`) IN ('norway');--> statement-breakpoint
UPDATE `companies` SET `country` = 'NG' WHERE lower(`country`) IN ('nigeria');--> statement-breakpoint
UPDATE `companies` SET `country` = 'NL' WHERE lower(`country`) IN ('netherlands', 'the netherlands');--> statement-breakpoint
UPDATE `companies` SET `country` = 'MY' WHERE lower(`country`) IN ('malaysia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'ID' WHERE lower(`country`) IN ('indonesia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'HK' WHERE lower(`country`) IN ('hong kong');--> statement-breakpoint
UPDATE `companies` SET `country` = 'BE' WHERE lower(`country`) IN ('belgium');--> statement-breakpoint
UPDATE `companies` SET `country` = 'UY' WHERE lower(`country`) IN ('uruguay');--> statement-breakpoint
UPDATE `companies` SET `country` = 'TZ' WHERE lower(`country`) IN ('tanzania');--> statement-breakpoint
UPDATE `companies` SET `country` = 'KR' WHERE lower(`country`) IN ('south korea');--> statement-breakpoint
UPDATE `companies` SET `country` = 'ZA' WHERE lower(`country`) IN ('south africa');--> statement-breakpoint
UPDATE `companies` SET `country` = 'SA' WHERE lower(`country`) IN ('saudi arabia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'RO' WHERE lower(`country`) IN ('romania');--> statement-breakpoint
UPDATE `companies` SET `country` = 'PT' WHERE lower(`country`) IN ('portugal');--> statement-breakpoint
UPDATE `companies` SET `country` = 'LT' WHERE lower(`country`) IN ('lithuania');--> statement-breakpoint
UPDATE `companies` SET `country` = 'JO' WHERE lower(`country`) IN ('jordan');--> statement-breakpoint
UPDATE `companies` SET `country` = 'EE' WHERE lower(`country`) IN ('estonia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'LV' WHERE lower(`country`) IN ('latvia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CY' WHERE lower(`country`) IN ('cyprus');--> statement-breakpoint
UPDATE `companies` SET `country` = 'BG' WHERE lower(`country`) IN ('bulgaria');--> statement-breakpoint
UPDATE `companies` SET `country` = 'IT' WHERE lower(`country`) IN ('italy');--> statement-breakpoint
UPDATE `companies` SET `country` = 'IE' WHERE lower(`country`) IN ('ireland');--> statement-breakpoint
UPDATE `companies` SET `country` = 'AT' WHERE lower(`country`) IN ('austria');--> statement-breakpoint
UPDATE `companies` SET `country` = 'FI' WHERE lower(`country`) IN ('finland');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CZ' WHERE lower(`country`) IN ('czech republic', 'czechia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'SI' WHERE lower(`country`) IN ('slovenia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'SK' WHERE lower(`country`) IN ('slovakia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'HU' WHERE lower(`country`) IN ('hungary');--> statement-breakpoint
UPDATE `companies` SET `country` = 'MD' WHERE lower(`country`) IN ('moldova');--> statement-breakpoint
UPDATE `companies` SET `country` = 'AM' WHERE lower(`country`) IN ('armenia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'JP' WHERE lower(`country`) IN ('japan');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CN' WHERE lower(`country`) IN ('china');--> statement-breakpoint
UPDATE `companies` SET `country` = 'TR' WHERE lower(`country`) IN ('turkey', 'türkiye');--> statement-breakpoint
UPDATE `companies` SET `country` = 'AR' WHERE lower(`country`) IN ('argentina');--> statement-breakpoint
UPDATE `companies` SET `country` = 'CL' WHERE lower(`country`) IN ('chile');--> statement-breakpoint
UPDATE `companies` SET `country` = 'NZ' WHERE lower(`country`) IN ('new zealand');--> statement-breakpoint
UPDATE `companies` SET `country` = 'PK' WHERE lower(`country`) IN ('pakistan');--> statement-breakpoint
UPDATE `companies` SET `country` = 'PH' WHERE lower(`country`) IN ('philippines');--> statement-breakpoint
UPDATE `companies` SET `country` = 'EG' WHERE lower(`country`) IN ('egypt');--> statement-breakpoint
UPDATE `companies` SET `country` = 'KE' WHERE lower(`country`) IN ('kenya');--> statement-breakpoint
UPDATE `companies` SET `country` = 'RS' WHERE lower(`country`) IN ('serbia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'HR' WHERE lower(`country`) IN ('croatia');--> statement-breakpoint
UPDATE `companies` SET `country` = 'GR' WHERE lower(`country`) IN ('greece');--> statement-breakpoint
UPDATE `companies` SET `country` = NULL WHERE lower(`country`) IN ('remote', 'worldwide', 'global', 'anywhere');--> statement-breakpoint
UPDATE `companies` SET `market` = CASE WHEN `country` IS NULL THEN NULL WHEN `country` = 'UA' THEN 'ua' ELSE 'intl' END;
