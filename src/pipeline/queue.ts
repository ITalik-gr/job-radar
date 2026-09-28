import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { rules } from './rules.js';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  outreach,
  queueItems,
  vacancies,
  type QueueItem,
} from '../db/schema.js';
import { log } from '../lib/log.js';
import { localDay } from '../lib/time.js';

/**
 * Companies whose cards are not shown. `replied` is here too: a company in the middle of a
 * conversation getting fresh cold cards next to it was noise. Both contact statuses come back
 * after `recontactAfterDays`, see `candidates`.
 */
export const HIDDEN_STATUSES = ['contacted', 'replied', 'rejected_by_me', 'rejected_by_them', 'blacklist'];

const CONTACT_STATUSES = ['contacted', 'replied'];

/**
 * At most this many cards of one company per day. A company posting a dozen similar roles
 * used to take the whole queue, while the decision is really one: write to them or not.
 */
export const CARDS_PER_COMPANY = 2;

export function todayKey(now = new Date()): string {
  return localDay(now);
}

export interface QueueCard {
  queueItemId: number;
  position: number;
  decision: string | null;
  vacancyId: number;
  title: string | null;
  url: string;
  score: number | null;
  stack: string[];
  seniority: string | null;
  remote: boolean | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  why: string | null;
  rawText: string | null;
  needsReview: boolean;
  companyId: number;
  company: string;
  domain: string;
  careersUrl: string | null;
  companyStatus: string;
  /** Set when the company was contacted long ago and showing it is an allowed exception. */
  contactedNote: string | null;
  /** When the card was first shown. Differs from today if it was carried over. */
  firstShownAt: number;
}

/** Queue candidates: open, above the threshold, company not in a hidden status. */
async function candidates(limit: number, day: string) {
  const db = getDb();
  const alreadyQueued = db
    .select({ id: queueItems.vacancyId })
    .from(queueItems)
    .where(sql`${queueItems.day} >= date(${day}, '-30 day')`);

  const rows = await db
    .select({
      vacancy: vacancies,
      company: companies,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      stateUpdatedAt: companyState.updatedAt,
      stateReason: companyState.reason,
    })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId))
    .where(
      and(
        isNull(vacancies.closedAt),
        sql`${vacancies.score} >= ${rules().threshold}`,
        or(eq(vacancies.isVacancy, true), isNull(vacancies.isVacancy)),
        sql`${vacancies.id} not in ${alreadyQueued}`,
      ),
    )
    .orderBy(desc(vacancies.score), desc(vacancies.firstSeen));

  const now = Date.now();
  const recontactAfter = config.pipeline.recontactAfterDays * 86_400_000;

  const eligible = rows.filter((row) => {
    const status = row.status ?? 'new';
    if (row.snoozedUntil && row.snoozedUntil > now) return false;
    if (!HIDDEN_STATUSES.includes(status)) return true;

    // The only exception: contacted long ago, and the vacancy is new. After a quarter that is fine.
    if (!CONTACT_STATUSES.includes(status)) return false;
    const contactedAgo = now - (row.stateUpdatedAt ?? 0);
    return contactedAgo > recontactAfter && row.vacancy.firstSeen > (row.stateUpdatedAt ?? 0);
  });

  const perCompany = new Map<number, number>();
  const picks: typeof eligible = [];
  for (const row of eligible) {
    const taken = perCompany.get(row.company.id) ?? 0;
    if (taken >= CARDS_PER_COMPANY) continue;
    perCompany.set(row.company.id, taken + 1);
    picks.push(row);
    if (picks.length >= limit) break;
  }
  return picks;
}

/**
 * Undecided cards from previous days move into today's slice.
 *
 * Why: a card the owner did not act on used to vanish the next day, and the repeat guard
 * kept it from coming back for 30 days. Skip a day, lose a vacancy.
 *
 * The row moves rather than being copied. A copy would create a second record for the same
 * vacancy: `stats.shown` counts rows and would report an inflated number, and `created_at`
 * would stop meaning the date of first display. Moving loses nothing.
 *
 * FIFO order, longest waiting first: otherwise a fresh vacancy with a higher score would push
 * the old one back every day, and it would never get a decision.
 */
interface LastLetter {
  sentAt: number | null;
  templateUsed: string | null;
  replyAt: number | null;
}

/** The latest sent letter per company, for the "wrote on ..., template ..." badge. */
async function lastLetterByCompany(companyIds: number[]): Promise<Map<number, LastLetter>> {
  const result = new Map<number, LastLetter>();
  if (companyIds.length === 0) return result;
  const rows = await getDb()
    .select({
      companyId: outreach.companyId,
      sentAt: outreach.sentAt,
      templateUsed: outreach.templateUsed,
      replyAt: outreach.replyAt,
    })
    .from(outreach)
    .where(and(inArray(outreach.companyId, [...new Set(companyIds)]), isNotNull(outreach.sentAt)))
    .orderBy(desc(outreach.sentAt));
  for (const row of rows) if (!result.has(row.companyId)) result.set(row.companyId, row);
  return result;
}

/**
 * CLAUDE.md 5.6: "wrote on 12.03, template fullstack_ai, no reply". The date comes from the
 * letter itself; the state's `updated_at` moves with any later edit and was only a fallback.
 */
function noteFor(status: string, letter: LastLetter | undefined, stateUpdatedAt: number | null): string {
  const at = letter?.sentAt ?? stateUpdatedAt;
  const date = at ? new Date(at).toLocaleDateString('en-GB') : 'earlier';
  const template = letter?.templateUsed ? `, template ${letter.templateUsed}` : '';
  const reply = status === 'replied' || letter?.replyAt ? 'replied' : 'no reply';
  return `wrote on ${date}${template}, ${reply}`;
}

async function carryOver(day: string, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const db = getDb();

  const rows = await db
    .select({
      item: queueItems,
      vacancy: vacancies,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
    })
    .from(queueItems)
    .innerJoin(vacancies, eq(vacancies.id, queueItems.vacancyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId))
    .where(and(isNull(queueItems.decision), sql`${queueItems.day} < ${day}`))
    .orderBy(asc(queueItems.createdAt), desc(vacancies.score));

  const now = Date.now();
  const threshold = rules().threshold;

  // The same conditions as for new candidates: while waiting, the vacancy may have closed,
  // the company may have been blocked or snoozed, and the config weights may have changed.
  const eligible = rows
    .filter((row) => {
      if (row.vacancy.closedAt) return false;
      if ((row.vacancy.score ?? -100) < threshold) return false;
      if (row.snoozedUntil && row.snoozedUntil > now) return false;
      return !HIDDEN_STATUSES.includes(row.status ?? 'new');
    })
    .slice(0, limit);

  for (const [index, row] of eligible.entries()) {
    await db
      .update(queueItems)
      .set({ day, position: index + 1 })
      .where(eq(queueItems.id, row.item.id));
  }

  if (eligible.length > 0) log.info({ day, carried: eligible.length }, 'undecided cards carried over');
  return eligible.length;
}

/**
 * The queue for the day. The first call of the day fixes the slice, later calls return the
 * same order. A decision removes a card, but the slot is not refilled: a daily limit is a limit.
 */
export async function getQueue(
  day = todayKey(),
  limit = config.pipeline.queueDailyLimit,
): Promise<QueueCard[]> {
  const db = getDb();
  let items: QueueItem[] = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.day, day))
    .orderBy(asc(queueItems.position));

  if (items.length === 0) {
    // Carried cards take limit slots first, new ones fill the rest.
    const carried = await carryOver(day, limit);
    const picks = await candidates(limit - carried, day);
    if (picks.length > 0) {
      await db.insert(queueItems).values(
        picks.map((pick, index) => ({
          day,
          vacancyId: pick.vacancy.id,
          position: carried + index + 1,
          scoreAtPick: pick.vacancy.score,
        })),
      );
      log.info({ day, picked: picks.length, carried }, 'queue slice fixed');
    }
    items = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.day, day))
      .orderBy(asc(queueItems.position));
  }

  if (items.length === 0) return [];

  const rows = await db
    .select({
      vacancy: vacancies,
      company: companies,
      status: companyState.status,
      stateUpdatedAt: companyState.updatedAt,
    })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId))
    .where(
      inArray(
        vacancies.id,
        items.map((item) => item.vacancyId),
      ),
    );

  const byId = new Map(rows.map((row) => [row.vacancy.id, row]));
  const lastLetters = await lastLetterByCompany(
    rows.filter((row) => CONTACT_STATUSES.includes(row.status ?? 'new')).map((row) => row.company.id),
  );

  const threshold = rules().threshold;

  return items
    .map((item) => {
      const row = byId.get(item.vacancyId);
      if (!row) return null;
      const status = row.status ?? 'new';
      const contactedNote = CONTACT_STATUSES.includes(status)
        ? noteFor(status, lastLetters.get(row.company.id), row.stateUpdatedAt)
        : null;

      return {
        queueItemId: item.id,
        position: item.position,
        decision: item.decision,
        vacancyId: row.vacancy.id,
        title: row.vacancy.title,
        url: row.vacancy.url,
        score: row.vacancy.score,
        stack: row.vacancy.stack,
        seniority: row.vacancy.seniority,
        remote: row.vacancy.remote,
        location: row.vacancy.location,
        salaryMin: row.vacancy.salaryMin,
        salaryMax: row.vacancy.salaryMax,
        currency: row.vacancy.currency,
        why: row.vacancy.llmWhy,
        rawText: row.vacancy.rawText,
        needsReview: row.vacancy.needsReview,
        companyId: row.company.id,
        company: row.company.name,
        domain: row.company.domain,
        careersUrl: row.company.careersUrl,
        companyStatus: status,
        contactedNote,
        firstShownAt: item.createdAt,
      } satisfies QueueCard;
    })
    .filter((card): card is QueueCard => card !== null)
    // The slice fixes order and contents for the day, but if a card no longer clears the
    // threshold after a rules edit, showing it would be dishonest. Decisions stay.
    .filter((card) => card.decision !== null || (card.score ?? -100) >= threshold);
}

/**
 * Top up today's slice to the daily limit.
 *
 * Why a separate action rather than automatic: the slice is fixed on purpose, a decision
 * documented in STATUS.md. Without it a new vacancy with a higher score would push out one
 * not yet looked at. But the opposite happens too: in the morning there were three
 * candidates, the slice fixed at three, then a daytime source run brought twenty more, and
 * the owner sees three cards over a full database. So topping up exists, but only on request.
 *
 * Cards already in the slice are left alone: neither position nor decision changes.
 */
export async function topUpQueue(
  day = todayKey(),
  limit = config.pipeline.queueDailyLimit,
): Promise<{ added: number; total: number }> {
  const db = getDb();
  const existing = await db.select().from(queueItems).where(eq(queueItems.day, day));

  const free = limit - existing.length;
  if (free <= 0) return { added: 0, total: existing.length };

  const picks = await candidates(free, day);
  if (picks.length === 0) return { added: 0, total: existing.length };

  await db.insert(queueItems).values(
    picks.map((pick, index) => ({
      day,
      vacancyId: pick.vacancy.id,
      position: existing.length + index + 1,
      scoreAtPick: pick.vacancy.score,
    })),
  );

  log.info({ day, added: picks.length }, 'queue slice topped up by hand');
  return { added: picks.length, total: existing.length + picks.length };
}

/** How many cards still await a decision today. */
export async function pendingCount(day = todayKey()): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(queueItems)
    .where(and(eq(queueItems.day, day), isNull(queueItems.decision)));
  return row?.n ?? 0;
}
