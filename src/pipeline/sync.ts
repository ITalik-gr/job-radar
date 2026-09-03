import { eq } from 'drizzle-orm';
import { anyToText } from '../lib/html.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { getDb } from '../db/client.js';
import { companies, type Company } from '../db/schema.js';
import { getSource, type RawVacancy } from '../sources/registry.js';
import { companiesForAts } from './companies.js';
import { closeMissing, ingestVacancies, type IngestStats } from './ingest.js';
import { dedupeKey } from './dedupe.js';

export interface SyncOptions {
  slug?: string;
  limit?: number;
  skipLlm?: boolean;
  /** Не довантажувати сторінку вакансії, навіть якщо блок короткий. */
  noDetail?: boolean;
}

/** Довантаження опису для коротких блоків: без нього вилка і англійська будуть null. */
async function fetchDetail(vacancy: RawVacancy): Promise<string | null> {
  try {
    const res = await fetchText(vacancy.url);
    return anyToText(res.body).slice(0, 20000) || null;
  } catch (error) {
    log.warn({ url: vacancy.url, err: String(error) }, 'не вдалось довантажити сторінку вакансії');
    return null;
  }
}

export interface SyncResult extends IngestStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  closed: number;
}

/** Повний прохід джерела: забрати, класифікувати, зберегти, закрити зниклі. */
export async function syncSource(id: string, options: SyncOptions = {}): Promise<SyncResult> {
  const source = getSource(id);
  if (!source) throw new Error(`невідоме джерело: ${id}`);
  if (source.kind !== 'board') throw new Error(`джерело ${id} не є бордом вакансій`);

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

      if (targets.length === 0) log.warn({ source: id }, 'немає компаній із цим ATS');

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
          log.warn({ source: id, err: message }, 'помилка на одному slug, йду далі');
        }
      }
    } else {
      const items = await source.fetch({});
      found += items.length;
      add(await ingestVacancies(items.slice(0, options.limit ?? items.length), ingestOptions));
    }

    return { ...totals, itemsFound: found, itemsNew: totals.created, errors, closed };
  });
}

/** Компанії, які мають бути перевірені на цьому проході. */
export async function companyByDomain(domain: string): Promise<Company | undefined> {
  const [row] = await getDb().select().from(companies).where(eq(companies.domain, domain));
  return row;
}
