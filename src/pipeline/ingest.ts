import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, companyState, vacancies, type Company } from '../db/schema.js';
import { log } from '../lib/log.js';
import { isUsefulDetail } from '../lib/detail.js';
import { normalizeDomain } from '../lib/normalize.js';
import type { RawVacancy } from '../sources/registry.js';
import { classifyText, type ClassifyOptions } from './classify.js';
import { dedupeKey, dedupeStem, mergeSources, REPOST_AFTER_MS } from './dedupe.js';
import { affixesForCompany, stripBoilerplate } from './boilerplate.js';
import { upsertCompany } from './companies.js';
import { hasStopWord, scoreVacancy, STOP_WORD_SCORE } from './score.js';
import { rules } from './rules.js';
import { HIDDEN_STATUSES } from './queue.js';

/** The most the model can add: llm_relevance 100 divided by 20. */
export const LLM_MAX_BOOST = 5;

export interface IngestOptions extends ClassifyOptions {
  /** Do not call the model at all: useful for a dry run and for tests. */
  skipLlm?: boolean;
  /** Fetch the full vacancy page text if the block has too little. */
  fetchDetail?: (vacancy: RawVacancy) => Promise<string | null>;
  /** Below this length a block counts as too short for classification. */
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
  /** The page opened, but had no description: an SPA or a redirect. */
  emptyDetail: number;
  /** How many records did not go to the model because the free rules filtered them out. */
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
    // RSS gives only a name without a domain, so only an exact name match is used.
    const [byName] = await db.select().from(companies).where(eq(companies.name, item.companyName));
    if (byName) return byName;
  }

  /*
   * The company is not in the database yet. The vacancy used to be silently dropped here, which ate
   * the whole output of sources that bring new companies along with vacancies: accelerator boards,
   * DOU, Djinni. The logs had only a debug "company not recognised".
   *
   * A company is created only when there is both a name and a domain: without a domain the record
   * would not be stored anyway, and a domain must not be invented from the board URL, otherwise
   * every Djinni vacancy would become one company "djinni.co".
   */
  if (domain && item.companyName) {
    const { company } = await upsertCompany({
      name: item.companyName,
      domain,
      source: item.source,
      sourceUrl: item.url,
    });
    log.info({ domain, name: item.companyName, source: item.source }, 'new company from a vacancy');
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
 * One pass: stop words, description fetch, classification, scoring, dedupe, storage.
 * Everything below the threshold is stored too, it is just not shown in the queue.
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
    emptyDetail: 0,
    skippedByFilter: 0,
  };
  const threshold = options.detailThreshold ?? 400;

  for (const item of items) {
    const owner = await resolveCompany(item, company);
    if (!owner) {
      log.debug({ url: item.url, name: item.companyName }, 'company not recognised, skipping');
      continue;
    }

    const key = dedupeKey({ domain: owner.domain, title: item.title, url: item.url });
    const existing = await findExisting(owner.id, dedupeStem(key));

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

    // Layer 1 on the short block text: free and before any network cost.
    let text = `${item.title ?? ''}\n${item.rawText}`;
    if (hasStopWord(text, item.title ?? '')) {
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

    // A list block is short, neither the salary nor the English level can be extracted from it.
    let rawText = item.rawText;
    if (options.fetchDetail && rawText.length < threshold) {
      const detail = await options.fetchDetail(item);
      /*
       * A longer page does not mean better text. SPA boards keep only navigation in the HTML, and
       * without a prose check the radar stored the menu as the vacancy description and then paid
       * to classify it.
       */
      if (detail && detail.length > rawText.length && isUsefulDetail(detail)) {
        rawText = detail;
        text = `${item.title ?? ''}\n${rawText}`;
        stats.detailed += 1;
      } else if (detail) {
        log.debug({ url: item.url }, 'vacancy page without a description, keeping the short text');
        stats.emptyDetail += 1;
      }
    }

    // Layer 1 again, on the full text: the word angular appears in descriptions more often than in titles.
    if (hasStopWord(text, item.title ?? '')) {
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

    // Deterministic filters run BEFORE the model. They are free and filter out most records: wrong
    // role, wrong geo, or a score so low that even the maximum 5 points from the model cannot
    // lift it to the threshold.
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
     * The "about the company" block is cut out before the model: it is identical across all
     * vacancies of one company, and on live data it is half the text. Scoring and storage work with
     * the full text, the trimmed one goes **only** to the model.
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
 * How many ids go into one `in (...)`. The D1 limit is a hundred parameters per query, and one is
 * taken by the timestamp, so the margin is kept deliberately wide.
 */
const CLOSE_BATCH = 90;

/**
 * The same vacancy seen before: same company, host and title, open or seen recently. The
 * week is left out on purpose, see `dedupeStem`.
 */
async function findExisting(companyId: number, stem: string) {
  const db = getDb();
  const prefix = `${stem}|`;
  const [row] = await db
    .select()
    .from(vacancies)
    .where(
      and(
        eq(vacancies.companyId, companyId),
        // substr rather than LIKE: an underscore in a domain or title would be a wildcard there.
        sql`substr(${vacancies.dedupeKey}, 1, ${prefix.length}) = ${prefix}`,
      ),
    )
    .orderBy(desc(vacancies.lastSeen))
    .limit(1);

  if (!row) return undefined;
  if (row.closedAt === null || row.lastSeen > Date.now() - REPOST_AFTER_MS) return row;
  return undefined;
}

/**
 * Vacancies no longer present in the source response are closed.
 * Data is never deleted: the difference between first_seen and closed_at is a future dataset.
 */
export async function closeMissing(
  companyId: number,
  source: string,
  seenKeys: string[],
): Promise<number> {
  const db = getDb();
  const open = await db
    .select({ id: vacancies.id, dedupeKey: vacancies.dedupeKey, source: vacancies.source })
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNull(vacancies.closedAt)));

  /*
   * Compared without the week, and only among this source's vacancies: a Greenhouse pass knows
   * nothing about what the company posted on Djinni or DOU, and used to close those too.
   */
  const seen = new Set(seenKeys.map(dedupeStem));
  const stale = open
    .filter((row) => row.source.split(',').includes(source))
    .filter((row) => !seen.has(dedupeStem(row.dedupeKey)))
    .map((row) => row.id);
  if (stale.length === 0) return 0;

  /*
   * Closing happens in batches, because D1 accepts no more than a hundred bound parameters per
   * query. Boards like Greenhouse give hundreds of vacancies at once for a large company, and a
   * single `in (?, ?, ...)` over the whole list failed with "Failed query" exactly where the source
   * works best. Local SQLite handles more, but the lowest limit is used: the same code runs both
   * in Node and on Workers.
   */
  const closedAt = Date.now();
  for (let i = 0; i < stale.length; i += CLOSE_BATCH) {
    const batch = stale.slice(i, i + CLOSE_BATCH);
    await db.update(vacancies).set({ closedAt }).where(inArray(vacancies.id, batch));
  }
  log.info({ companyId, source, closed: stale.length }, 'vacancies closed');
  return stale.length;
}

/** The daily queue: the threshold from config, excluding what was seen, the card limit. */
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

  const hidden = new Set(HIDDEN_STATUSES);
  const now = Date.now();

  return rows
    .filter((row) => (row.score ?? -100) >= config.pipeline.scoreThreshold)
    .filter((row) => !hidden.has(row.status ?? 'new'))
    .filter((row) => !row.snoozedUntil || row.snoozedUntil < now)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
