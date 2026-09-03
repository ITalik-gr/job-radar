import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { rules } from './rules.js';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  queueItems,
  vacancies,
  type QueueItem,
} from '../db/schema.js';
import { log } from '../lib/log.js';

export const HIDDEN_STATUSES = ['contacted', 'rejected_by_me', 'rejected_by_them', 'blacklist'];

export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
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
  /** Заповнене, якщо компанії вже писали давно і показ дозволений як виняток. */
  contactedNote: string | null;
}

/** Кандидати на чергу: відкриті, вище порогу, компанія не в списку прихованих статусів. */
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

    // Єдиний виняток: писали давно, а вакансія нова. Через квартал це нормально.
    if (status !== 'contacted') return false;
    const contactedAgo = now - (row.stateUpdatedAt ?? 0);
    return contactedAgo > recontactAfter && row.vacancy.firstSeen > (row.stateUpdatedAt ?? 0);
  });

  return eligible.slice(0, limit);
}

/**
 * Черга на день. Перший виклик за добу фіксує зріз, наступні повертають той самий
 * порядок. Рішення прибирає картку, але місце не переобирається: ліміт на день це ліміт.
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
    const picks = await candidates(limit, day);
    if (picks.length > 0) {
      await db.insert(queueItems).values(
        picks.map((pick, index) => ({
          day,
          vacancyId: pick.vacancy.id,
          position: index + 1,
          scoreAtPick: pick.vacancy.score,
        })),
      );
      log.info({ day, picked: picks.length }, 'зріз черги зафіксовано');
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

  const threshold = rules().threshold;

  return items
    .map((item) => {
      const row = byId.get(item.vacancyId);
      if (!row) return null;
      const status = row.status ?? 'new';
      const contactedNote =
        status === 'contacted' && row.stateUpdatedAt
          ? `писали ${new Date(row.stateUpdatedAt).toLocaleDateString('uk-UA')}, відповіді не було`
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
      } satisfies QueueCard;
    })
    .filter((card): card is QueueCard => card !== null)
    // Зріз фіксує порядок і склад на добу, але якщо після правки config/scoring.json
    // картка більше не проходить поріг, показувати її нечесно. Рішення лишаються.
    .filter((card) => card.decision !== null || (card.score ?? -100) >= threshold);
}

/** Скільки карток ще чекають рішення сьогодні. */
export async function pendingCount(day = todayKey()): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(queueItems)
    .where(and(eq(queueItems.day, day), isNull(queueItems.decision)));
  return row?.n ?? 0;
}
