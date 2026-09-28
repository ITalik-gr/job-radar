import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { outreach, queueItems, vacancies, type Vacancy } from '../db/schema.js';
import { log } from '../lib/log.js';
import { dedupeStem, mergeSources } from './dedupe.js';

/**
 * Repair for the weekly duplicates.
 *
 * Until the dedupe fix the lookup used the current week, so every Monday each open vacancy
 * got a new row and the previous one was closed in the same pass. The result is a chain of
 * rows per vacancy, each about a week long. This folds every chain back into its first row:
 * earliest `first_seen`, latest `last_seen`, the latest row's `closed_at` and classification,
 * and the letters and queue cards re-pointed to it. The extra rows are artifacts of the bug,
 * not observations, so they are removed.
 *
 * Two rows belong to one chain when the newer one appeared within a day of the older one
 * closing: that is the signature of the bug. A vacancy re-posted weeks later stays separate.
 */

const SAME_PASS_MS = 86_400_000;

export interface MergeReport {
  groups: number;
  merged: number;
  /** Chains left for the next call, because of `limit`. */
  remaining: number;
  applied: boolean;
}

/** The columns chains are found by. Raw text stays in the database: the table is large. */
export type ChainRow = Pick<Vacancy, 'id' | 'companyId' | 'dedupeKey' | 'firstSeen' | 'lastSeen' | 'closedAt' | 'source'>;

/** Chains of rows that are one vacancy split by the weekly key. Pure, for tests. */
export function findChains<T extends ChainRow>(rows: T[]): T[][] {
  const byStem = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.companyId}|${dedupeStem(row.dedupeKey)}`;
    const list = byStem.get(key) ?? [];
    list.push(row);
    byStem.set(key, list);
  }

  const chains: T[][] = [];
  for (const list of byStem.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.firstSeen - b.firstSeen);

    let chain: T[] = [list[0]!];
    for (const row of list.slice(1)) {
      const previous = chain[chain.length - 1]!;
      const continues =
        previous.closedAt !== null && Math.abs(row.firstSeen - previous.closedAt) <= SAME_PASS_MS;
      if (continues) {
        chain.push(row);
      } else {
        if (chain.length > 1) chains.push(chain);
        chain = [row];
      }
    }
    if (chain.length > 1) chains.push(chain);
  }
  return chains;
}

export async function mergeWeeklyDuplicates(options: { apply?: boolean; limit?: number } = {}): Promise<MergeReport> {
  const db = getDb();
  const rows = await db
    .select({
      id: vacancies.id,
      companyId: vacancies.companyId,
      dedupeKey: vacancies.dedupeKey,
      firstSeen: vacancies.firstSeen,
      lastSeen: vacancies.lastSeen,
      closedAt: vacancies.closedAt,
      source: vacancies.source,
    })
    .from(vacancies)
    .orderBy(asc(vacancies.id));
  const chains = findChains(rows);
  const limit = options.limit ?? 100;
  const batch = chains.slice(0, limit);
  const merged = batch.reduce((sum, chain) => sum + chain.length - 1, 0);

  if (!options.apply) {
    return { groups: chains.length, merged: chains.reduce((s, c) => s + c.length - 1, 0), remaining: chains.length, applied: false };
  }

  for (const chain of batch) {
    const [keeper, ...extra] = chain as [ChainRow, ...ChainRow[]];
    const extraIds = extra.map((row) => row.id);
    const lastId = chain[chain.length - 1]!.id;
    const full = await db.select().from(vacancies).where(inArray(vacancies.id, [keeper.id, lastId]));
    const latest = full.find((row) => row.id === lastId)!;
    const first = full.find((row) => row.id === keeper.id)!;
    const classified = latest.llmRelevance !== null ? latest : first;

    await db
      .update(vacancies)
      .set({
        lastSeen: Math.max(...chain.map((row) => row.lastSeen)),
        closedAt: latest.closedAt,
        source: chain.reduce((acc, row) => mergeSources(acc, row.source), keeper.source),
        stack: classified.stack,
        seniority: classified.seniority,
        remote: classified.remote,
        location: classified.location,
        salaryMin: classified.salaryMin,
        salaryMax: classified.salaryMax,
        currency: classified.currency,
        englishLevelRequired: classified.englishLevelRequired,
        llmRelevance: classified.llmRelevance,
        llmWhy: classified.llmWhy,
        isVacancy: classified.isVacancy,
        needsReview: classified.needsReview,
        score: latest.score,
      })
      .where(eq(vacancies.id, keeper.id));

    await db.update(outreach).set({ vacancyId: keeper.id }).where(inArray(outreach.vacancyId, extraIds));

    // A queue card moves to the keeper unless the keeper already has a card that day.
    const keeperDays = new Set(
      (await db.select({ day: queueItems.day }).from(queueItems).where(eq(queueItems.vacancyId, keeper.id))).map(
        (row) => row.day,
      ),
    );
    const cards = await db.select().from(queueItems).where(inArray(queueItems.vacancyId, extraIds));
    for (const card of cards) {
      if (keeperDays.has(card.day)) {
        await db.delete(queueItems).where(eq(queueItems.id, card.id));
      } else {
        await db.update(queueItems).set({ vacancyId: keeper.id }).where(eq(queueItems.id, card.id));
        keeperDays.add(card.day);
      }
    }

    await db.delete(vacancies).where(and(inArray(vacancies.id, extraIds)));
  }

  log.info({ groups: batch.length, merged }, 'weekly duplicates merged');
  return { groups: batch.length, merged, remaining: chains.length - batch.length, applied: true };
}
