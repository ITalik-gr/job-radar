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
  /** Не довантажувати сторінку вакансії, навіть якщо блок короткий. */
  noDetail?: boolean;
}

/** Довантаження опису для коротких блоків: без нього вилка і англійська будуть null. */
async function fetchDetail(vacancy: RawVacancy): Promise<string | null> {
  try {
    const res = await fetchText(vacancy.url);
    /*
     * Спершу вбудований JSON, і лише потім розмітка. На Next.js-бордах у HTML
     * лежить хедер мережі на десятки тисяч символів, а опис вакансії тільки в
     * `__NEXT_DATA__`, тому зворотний порядок давав меню замість вакансії.
     */
    const embedded = jobTextFromNextData(res.body);
    if (embedded) return anyToText(embedded).slice(0, 20000);
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
      /*
       * Slug тут не обовʼязковий, але передається: Getro читає його як id мережі
       * і робить за раз тільки її. Решта джерел цього поля не помічає.
       */
      const items = await source.fetch({ slug: options.slug });
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

export interface RefreshDetailsReport {
  checked: number;
  fixed: number;
  unchanged: number;
  stillEmpty: number;
}

/**
 * Перечитати сторінки вакансій одного джерела свіжим витягом.
 *
 * Потрібно після виправлення парсера: у базі вже лежать вакансії, де описом
 * записане меню мережі, і перекласифікувати їх без свіжого тексту немає сенсу,
 * модель побачить те саме меню.
 *
 * Відбір іде за джерелом, а не спробою вгадати сміття за виглядом тексту.
 * Спроба була, і вона не працює: у тих самих Techstars частина сторінок
 * віддає опис, частина ні, тому спільного вигляду в сміття немає.
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
     * needsReview ставить вакансію в чергу перекласифікації: стара думка моделі
     * складалась про меню сайту, і лишати її означало б довіряти сміттю.
     */
    await db
      .update(vacancies)
      .set({ rawText: detail, needsReview: true })
      .where(eq(vacancies.id, row.id));
    report.fixed += 1;
  }

  log.info({ source, ...report }, 'опис вакансій перечитано');
  return report;
}
