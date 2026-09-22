import { getSource, type RawVacancy } from '../sources/registry.js';
import { withRun } from '../lib/runs.js';
import { log } from '../lib/log.js';
import { companiesForAts } from './companies.js';

export interface CrawlOptions {
  /** An explicit slug, to run the source without a company record in the database. */
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
 * Runs a single source. At Stage 2 the result is only returned to the caller, saving
 * vacancies to the database appears after dedup and scoring at Stage 4, so `itemsNew`
 * equals `itemsFound` for now.
 */
export async function crawlSource(id: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const source = getSource(id);
  if (!source) throw new Error(`unknown source: ${id}`);
  if (source.kind !== 'board') throw new Error(`source ${id} is not a vacancy board`);

  return withRun(id, async () => {
    const vacancies: RawVacancy[] = [];
    const errors: string[] = [];

    if (source.requiresSlug) {
      const targets = options.slug
        ? [{ slug: options.slug, company: undefined }]
        : (await companiesForAts(id)).map((company) => ({ slug: company.careersSlug!, company }));

      if (targets.length === 0) {
        log.warn({ source: id }, 'no companies with this ATS, add them via companies:add');
      }

      for (const target of targets.slice(0, options.limit ?? targets.length)) {
        try {
          vacancies.push(...(await source.fetch({ slug: target.slug, company: target.company })));
        } catch (error) {
          const message = `${target.slug}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          log.warn({ source: id, err: message }, 'error on one slug, moving on');
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
