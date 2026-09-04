import { and, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, companyState, vacancies, type Company } from '../db/schema.js';
import { log } from '../lib/log.js';
import { normalizeDomain } from '../lib/normalize.js';
import type { RawVacancy } from '../sources/registry.js';
import { classifyText, type ClassifyOptions } from './classify.js';
import { dedupeKey, mergeSources } from './dedupe.js';
import { affixesForCompany, stripBoilerplate } from './boilerplate.js';
import { upsertCompany } from './companies.js';
import { hasStopWord, scoreVacancy, STOP_WORD_SCORE } from './score.js';
import { rules } from './rules.js';

/** Максимум, який модель може додати: llm_relevance 100 ділиться на 20. */
export const LLM_MAX_BOOST = 5;

export interface IngestOptions extends ClassifyOptions {
  /** Не викликати модель узагалі: корисно для сухого прогону і тестів. */
  skipLlm?: boolean;
  /** Довантажити повний текст сторінки вакансії, якщо в блоці його мало. */
  fetchDetail?: (vacancy: RawVacancy) => Promise<string | null>;
  /** Нижче цієї довжини блок вважається надто коротким для класифікації. */
  detailThreshold?: number;
}

export interface IngestStats {
  seen: number;
  created: number;
  updated: number;
  stopped: number;
  classified: number;
  needsReview: number;
  detailed: number;
  /** Скільки записів не пішли в модель, бо їх відсіяли безкоштовні правила. */
  skippedByFilter: number;
}

async function resolveCompany(item: RawVacancy, fallback?: Company): Promise<Company | null> {
  if (fallback) return fallback;
  const db = getDb();
  const domain = item.companyDomain ? normalizeDomain(item.companyDomain) : null;
  if (domain) {
    const [byDomain] = await db.select().from(companies).where(eq(companies.domain, domain));
    if (byDomain) return byDomain;
  }
  if (item.companyName) {
    // RSS дає лише назву без домену, тому зводимо тільки на точний збіг назви.
    const [byName] = await db.select().from(companies).where(eq(companies.name, item.companyName));
    if (byName) return byName;
  }

  /*
   * Компанії ще немає в базі. Раніше вакансія тут мовчки відкидалась, і це з'їдало
   * всю видачу джерел, які приносять нові компанії разом з вакансіями: борди
   * акселераторів, DOU, Djinni. У логах було лише debug "компанію не впізнано".
   *
   * Створюємо тільки коли є і назва, і домен: без домену запис однаково не
   * зберігся б, а вигадувати домен з адреси борду не можна, бо тоді всі вакансії
   * з Djinni стали б однією компанією "djinni.co".
   */
  if (domain && item.companyName) {
    const { company } = await upsertCompany({
      name: item.companyName,
      domain,
      source: item.source,
      sourceUrl: item.url,
    });
    log.info({ domain, name: item.companyName, source: item.source }, 'нова компанія з вакансії');
    return company;
  }

  return null;
}

async function isBlacklisted(companyId: number): Promise<boolean> {
  const db = getDb();
  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, companyId));
  return state?.status === 'blacklist';
}

/**
 * Один прохід: стоп-слова, довантаження опису, класифікація, скоринг, дедуп, запис.
 * Все, що нижче порогу, теж зберігається, просто не показується у черзі.
 */
export async function ingestVacancies(
  items: RawVacancy[],
  options: IngestOptions = {},
  company?: Company,
): Promise<IngestStats> {
  const db = getDb();
  const stats: IngestStats = {
    seen: items.length,
    created: 0,
    updated: 0,
    stopped: 0,
    classified: 0,
    needsReview: 0,
    detailed: 0,
    skippedByFilter: 0,
  };
  const threshold = options.detailThreshold ?? 400;

  for (const item of items) {
    const owner = await resolveCompany(item, company);
    if (!owner) {
      log.debug({ url: item.url, name: item.companyName }, 'компанію не впізнано, пропускаю');
      continue;
    }

    const key = dedupeKey({ domain: owner.domain, title: item.title, url: item.url });
    const [existing] = await db.select().from(vacancies).where(eq(vacancies.dedupeKey, key));

    if (existing) {
      await db
        .update(vacancies)
        .set({
          lastSeen: Date.now(),
          closedAt: null,
          source: mergeSources(existing.source, item.source),
        })
        .where(eq(vacancies.id, existing.id));
      stats.updated += 1;
      continue;
    }

    // Шар 1 по короткому тексту блока: безкоштовно і до будь-яких мережевих витрат.
    let text = `${item.title ?? ''}\n${item.rawText}`;
    if (hasStopWord(text)) {
      await db.insert(vacancies).values({
        companyId: owner.id,
        source: item.source,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        rawText: item.rawText,
        location: item.location,
        remote: item.remote,
        score: STOP_WORD_SCORE,
        dedupeKey: key,
      });
      stats.stopped += 1;
      stats.created += 1;
      continue;
    }

    // Блок зі списку короткий, з нього не витягти вилку і рівень англійської.
    let rawText = item.rawText;
    if (options.fetchDetail && rawText.length < threshold) {
      const detail = await options.fetchDetail(item);
      if (detail && detail.length > rawText.length) {
        rawText = detail;
        text = `${item.title ?? ''}\n${rawText}`;
        stats.detailed += 1;
      }
    }

    // Шар 1 повторно, вже по повному тексту: слово angular частіше в описі, ніж у назві.
    if (hasStopWord(text)) {
      await db.insert(vacancies).values({
        companyId: owner.id,
        source: item.source,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        rawText,
        location: item.location,
        remote: item.remote,
        score: STOP_WORD_SCORE,
        dedupeKey: key,
      });
      stats.stopped += 1;
      stats.created += 1;
      continue;
    }

    // Детерміновані фільтри ганяються ДО моделі. Вони безкоштовні і відсіюють
    // більшість: роль не та, гео не те, рахунок такий, що навіть максимальні
    // 5 балів від моделі не витягнуть його до порогу.
    const preliminary = scoreVacancy({
      text: rawText,
      title: item.title,
      location: item.location,
      remote: item.remote,
      companyDomain: owner.domain,
      companySizeHint: owner.sizeHint,
    });

    const hopeless = preliminary.rejectedBy !== null || preliminary.score < rules().threshold - LLM_MAX_BOOST;

    if (hopeless) {
      await db.insert(vacancies).values({
        companyId: owner.id,
        source: item.source,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        rawText,
        location: item.location,
        remote: item.remote,
        score: preliminary.score,
        dedupeKey: key,
      });
      stats.skippedByFilter += 1;
      stats.created += 1;
      continue;
    }

    /*
     * Перед моделлю вирізаємо блок "про компанію": у всіх вакансій однієї компанії
     * він однаковий, і на живих даних це половина тексту. Скоринг і збереження
     * працюють з повним текстом, урізаний іде **тільки** в модель.
     */
    const affixes = await affixesForCompany(owner.id);
    const forModel = stripBoilerplate(text, affixes).slice(0, config.llm.maxInputChars);

    const result = options.skipLlm
      ? { classification: null, reason: 'budget' as const, needsReview: false }
      : await classifyText(forModel, options);

    if (result.classification) stats.classified += 1;
    if (result.needsReview) stats.needsReview += 1;

    const llm = result.classification;
    const blacklisted = await isBlacklisted(owner.id);
    const breakdown = scoreVacancy({
      text: rawText,
      companyDomain: owner.domain,
      companySizeHint: owner.sizeHint,
      title: llm?.title ?? item.title,
      location: llm?.location ?? item.location,
      remote: llm?.remote ?? item.remote,
      salaryMin: llm?.salary_min ?? null,
      salaryMax: llm?.salary_max ?? null,
      seniority: llm?.seniority ?? null,
      englishLevelRequired: llm?.english_level_required ?? null,
      llmRelevance: llm?.relevance ?? null,
      blacklisted,
    });

    await db.insert(vacancies).values({
      companyId: owner.id,
      source: item.source,
      externalId: item.externalId,
      url: item.url,
      title: llm?.title ?? item.title,
      rawText,
      stack: llm?.stack ?? [],
      seniority: llm?.seniority ?? null,
      remote: llm?.remote ?? item.remote,
      location: llm?.location ?? item.location,
      salaryMin: llm?.salary_min ?? null,
      salaryMax: llm?.salary_max ?? null,
      currency: llm?.currency ?? null,
      englishLevelRequired: llm?.english_level_required ?? null,
      llmRelevance: llm?.relevance ?? null,
      llmWhy: llm?.why ?? null,
      isVacancy: llm ? llm.is_vacancy : null,
      needsReview: result.needsReview,
      score: breakdown.score,
      dedupeKey: key,
    });
    stats.created += 1;
  }

  return stats;
}

/**
 * Вакансії, яких більше немає у відповіді джерела, закриваються.
 * Дані не видаляються ніколи: різниця first_seen і closed_at це майбутній датасет.
 */
export async function closeMissing(
  companyId: number,
  source: string,
  seenKeys: string[],
): Promise<number> {
  const db = getDb();
  const open = await db
    .select({ id: vacancies.id, dedupeKey: vacancies.dedupeKey })
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNull(vacancies.closedAt)));

  const seen = new Set(seenKeys);
  const stale = open.filter((row) => !seen.has(row.dedupeKey)).map((row) => row.id);
  if (stale.length === 0) return 0;

  await db.update(vacancies).set({ closedAt: Date.now() }).where(inArray(vacancies.id, stale));
  log.info({ companyId, source, closed: stale.length }, 'вакансії закрито');
  return stale.length;
}

/** Черга на день: поріг за конфігом, виключення побаченого, ліміт карток. */
export async function queue(limit = config.pipeline.queueDailyLimit) {
  const db = getDb();
  const rows = await db
    .select({
      id: vacancies.id,
      title: vacancies.title,
      url: vacancies.url,
      score: vacancies.score,
      stack: vacancies.stack,
      location: vacancies.location,
      salaryMin: vacancies.salaryMin,
      salaryMax: vacancies.salaryMax,
      why: vacancies.llmWhy,
      company: companies.name,
      domain: companies.domain,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
    })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId))
    .where(isNull(vacancies.closedAt));

  const hidden = new Set(['contacted', 'rejected_by_me', 'rejected_by_them', 'blacklist']);
  const now = Date.now();

  return rows
    .filter((row) => (row.score ?? -100) >= config.pipeline.scoreThreshold)
    .filter((row) => !hidden.has(row.status ?? 'new'))
    .filter((row) => !row.snoozedUntil || row.snoozedUntil < now)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
