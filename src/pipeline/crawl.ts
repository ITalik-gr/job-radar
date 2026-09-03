import { getSource, type RawVacancy } from '../sources/registry.js';
import { withRun } from '../lib/runs.js';
import { log } from '../lib/log.js';
import { companiesForAts } from './companies.js';

export interface CrawlOptions {
  /** Явний slug, щоб прогнати джерело без запису компанії в базі. */
  slug?: string;
  limit?: number;
}

export interface CrawlResult {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  vacancies: RawVacancy[];
}

/**
 * Прогін одного джерела. На Етапі 2 результат тільки повертається назовні,
 * запис вакансій у базу зʼявиться після дедупу і скорингу на Етапі 4,
 * тому `itemsNew` поки дорівнює `itemsFound`.
 */
export async function crawlSource(id: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const source = getSource(id);
  if (!source) throw new Error(`невідоме джерело: ${id}`);
  if (source.kind !== 'board') throw new Error(`джерело ${id} не є бордом вакансій`);

  return withRun(id, async () => {
    const vacancies: RawVacancy[] = [];
    const errors: string[] = [];

    if (source.requiresSlug) {
      const targets = options.slug
        ? [{ slug: options.slug, company: undefined }]
        : (await companiesForAts(id)).map((company) => ({ slug: company.careersSlug!, company }));

      if (targets.length === 0) {
        log.warn({ source: id }, 'немає компаній із цим ATS, додай їх через companies:add');
      }

      for (const target of targets.slice(0, options.limit ?? targets.length)) {
        try {
          vacancies.push(...(await source.fetch({ slug: target.slug, company: target.company })));
        } catch (error) {
          const message = `${target.slug}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          log.warn({ source: id, err: message }, 'помилка на одному slug, йду далі');
        }
      }
    } else {
      vacancies.push(...(await source.fetch({})));
    }

    return {
      itemsFound: vacancies.length,
      itemsNew: vacancies.length,
      errors,
      vacancies,
    };
  });
}
