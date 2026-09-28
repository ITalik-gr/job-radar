import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { anyToText } from '../lib/html.js';
import { isUsefulDetail, jobTextFromNextData } from '../lib/detail.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { getDb } from '../db/client.js';
import { companies, vacancies, type Company } from '../db/schema.js';
import { getSource, type RawVacancy } from '../sources/registry.js';
import { companiesForAts } from './companies.js';
import { closeMissing, ingestVacancies, type IngestStats } from './ingest.js';
import { dedupeKey } from './dedupe.js';

export interface SyncOptions {
  slug?: string;
  limit?: number;
  skipLlm?: boolean;
  /** Don't fetch the vacancy page even if the block is short. */
  noDetail?: boolean;
}

/** Fetches the description for short blocks: without it, the salary range and English requirement stay null. */
export async function fetchDetail(vacancy: RawVacancy): Promise<string | null> {
  try {
    const res = await fetchText(vacancy.url);
    /*
     * The embedded JSON first, and only then the markup. On Next.js boards the HTML
     * carries the network's header running tens of thousands of characters, while the
     * vacancy description sits only in `__NEXT_DATA__`, so the reverse order returned
     * the menu instead of the vacancy.
     */
    const embedded = jobTextFromNextData(res.body);
    if (embedded) return anyToText(embedded).slice(0, 20000);
    return anyToText(res.body).slice(0, 20000) || null;
  } catch (error) {
    log.warn({ url: vacancy.url, err: String(error) }, 'failed to fetch the vacancy page');
    return null;
  }
}

export interface SyncResult extends IngestStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  closed: number;
}

/** A full pass over a source: fetch, classify, save, close missing ones. */
export async function syncSource(id: string, options: SyncOptions = {}): Promise<SyncResult> {
  const source = getSource(id);
  if (!source) throw new Error(`unknown source: ${id}`);
  if (source.kind !== 'board') throw new Error(`source ${id} is not a vacancy board`);

  return withRun(id, async () => {
    const errors: string[] = [];
    const totals: IngestStats = {
      seen: 0,
      created: 0,
      updated: 0,
      stopped: 0,
      classified: 0,
      needsReview: 0,
      detailed: 0,
      emptyDetail: 0,
      skippedByFilter: 0,
    };
    let closed = 0;
    let found = 0;

    const ingestOptions = {
      skipLlm: options.skipLlm,
      fetchDetail: options.noDetail ? undefined : fetchDetail,
    };

    const add = (stats: IngestStats) => {
      for (const key of Object.keys(totals) as (keyof IngestStats)[]) totals[key] += stats[key];
    };

    if (source.requiresSlug) {
      const targets: { slug: string; company?: Company }[] = options.slug
        ? [{ slug: options.slug }]
        : (await companiesForAts(id)).map((company) => ({ slug: company.careersSlug!, company }));

      if (targets.length === 0) log.warn({ source: id }, 'no companies with this ATS');

      for (const target of targets.slice(0, options.limit ?? targets.length)) {
        try {
          const items = await source.fetch(target);
          found += items.length;
          add(await ingestVacancies(items, ingestOptions, target.company));

          if (target.company) {
            const keys = items.map((item) =>
              dedupeKey({ domain: target.company!.domain, title: item.title, url: item.url }),
            );
            closed += await closeMissing(target.company.id, id, keys);
          }
        } catch (error) {
          const message = `${target.slug}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          log.warn({ source: id, err: message }, 'error on one slug, moving on');
        }
      }
    } else {
      /*
       * A slug isn't required here, but it's passed anyway: Getro reads it as a
       * network id and does only that one network per call. The other sources don't
       * notice this field.
       */
      const items = await source.fetch({ slug: options.slug });
      found += items.length;
      add(await ingestVacancies(items.slice(0, options.limit ?? items.length), ingestOptions));
    }

    return { ...totals, itemsFound: found, itemsNew: totals.created, errors, closed };
  });
}

/** Companies that need to be checked on this pass. */
export async function companyByDomain(domain: string): Promise<Company | undefined> {
  const [row] = await getDb().select().from(companies).where(eq(companies.domain, domain));
  return row;
}

export interface RefreshDetailsReport {
  checked: number;
  fixed: number;
  unchanged: number;
  stillEmpty: number;
}

/**
 * Re-reads the vacancy pages of one source with a fresh fetch.
 *
 * Needed after fixing a parser: the database already has vacancies whose description
 * is a network's menu, and reclassifying them without fresh text is pointless, the
 * model would see the same menu.
 *
 * Selection is by source, not by trying to guess garbage from what the text looks
 * like. That was tried, and it doesn't work: within the same Techstars, some pages
 * hand back a description and some don't, so there's no shared shape to the garbage.
 */
export async function refreshDetails(
  options: { source?: string; limit?: number } = {},
): Promise<RefreshDetailsReport> {
  const db = getDb();
  const source = options.source ?? 'getro';
  const limit = options.limit ?? 50;

  const rows = await db
    .select({ id: vacancies.id, url: vacancies.url, rawText: vacancies.rawText, title: vacancies.title })
    .from(vacancies)
    .where(and(isNull(vacancies.closedAt), like(vacancies.source, `%${source}%`)))
    .orderBy(desc(vacancies.score))
    .limit(limit);

  const report: RefreshDetailsReport = { checked: 0, fixed: 0, unchanged: 0, stillEmpty: 0 };

  for (const row of rows) {
    report.checked += 1;
    const detail = await fetchDetail({ url: row.url, title: row.title } as RawVacancy);

    if (!detail || !isUsefulDetail(detail)) {
      report.stillEmpty += 1;
      continue;
    }
    if (detail === row.rawText) {
      report.unchanged += 1;
      continue;
    }

    /*
     * needsReview puts the vacancy into the reclassification queue: the model's old
     * opinion was formed about the site's menu, and keeping it would mean trusting garbage.
     */
    await db
      .update(vacancies)
      .set({ rawText: detail, needsReview: true })
      .where(eq(vacancies.id, row.id));
    report.fixed += 1;
  }

  log.info({ source, ...report }, 'vacancy descriptions re-read');
  return report;
}
