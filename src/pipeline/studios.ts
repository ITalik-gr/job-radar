import { and, desc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, outreach, vacancies, type Company } from '../db/schema.js';
import { scoreCompany, type CompanyBreakdown } from './company-score.js';
import { rules } from './rules.js';
import { HIDDEN_STATUSES } from './queue.js';

/**
 * Черга студій: кому писати з пропозицією послуг. Вакансія тут не потрібна,
 * тому це окремий список від черги вакансій, з тими самими діями над станом компанії.
 */

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  tags: string[];
  techHints: string[];
  description: string | null;
  careersUrl: string | null;
  /** Сторінка компанії в каталозі, звідки вона прийшла. */
  sourceUrl: string | null;
  sources: string[];
  status: string;
  openVacancies: number;
  score: number;
  why: { reason: string; weight: number }[];
  contacts: { name: string | null; role: string | null; email: string | null }[];
  lastContactedAt: number | null;
}

export interface StudioFilters {
  limit?: number;
  minScore?: number;
  /** Показати всіх, включно з тими, кому вже писали. */
  includeContacted?: boolean;
  country?: string;
  search?: string;
}

export async function studioQueue(filters: StudioFilters = {}): Promise<StudioCard[]> {
  const db = getDb();
  const minScore = filters.minScore ?? rules().companies.threshold;

  const rows = await db
    .select({
      company: companies,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      openVacancies: sql<number>`(
        select count(*) from ${vacancies}
        where ${vacancies.companyId} = ${companies.id} and ${vacancies.closedAt} is null
      )`,
      lastContactedAt: sql<number | null>`(
        select max(${outreach.sentAt}) from ${outreach} where ${outreach.companyId} = ${companies.id}
      )`,
    })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      filters.country
        ? and(eq(companies.country, filters.country), ne(companies.domain, ''))
        : undefined,
    );

  const now = Date.now();
  const contactRows = await db.select().from(contacts);
  const byCompany = new Map<number, typeof contactRows>();
  for (const row of contactRows) {
    byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row]);
  }

  const cards = rows
    .filter((row) => {
      const status = row.status ?? 'new';
      if (row.snoozedUntil && row.snoozedUntil > now) return false;
      if (filters.includeContacted) return status !== 'blacklist';
      return !HIDDEN_STATUSES.includes(status);
    })
    .filter((row) => {
      if (!filters.search) return true;
      const needle = filters.search.toLowerCase();
      return (
        row.company.name.toLowerCase().includes(needle) ||
        row.company.domain.includes(needle) ||
        row.company.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    })
    .map((row) => {
      const breakdown: CompanyBreakdown = scoreCompany({
        company: row.company,
        openVacancies: row.openVacancies,
        status: row.status,
      });

      return {
        companyId: row.company.id,
        name: row.company.name,
        domain: row.company.domain,
        country: row.company.country,
        city: row.company.city,
        sizeHint: row.company.sizeHint,
        tags: row.company.tags,
        techHints: row.company.techHints,
        description: row.company.description,
        careersUrl: row.company.careersUrl,
        sourceUrl: row.company.sourceUrl,
        sources: row.company.sources,
        status: row.status ?? 'new',
        openVacancies: row.openVacancies,
        score: breakdown.score,
        why: [...breakdown.positives, ...breakdown.negatives].sort((a, b) => b.weight - a.weight),
        contacts: (byCompany.get(row.company.id) ?? []).map((contact) => ({
          name: contact.name,
          role: contact.role,
          email: contact.email,
        })),
        lastContactedAt: row.lastContactedAt,
      } satisfies StudioCard;
    })
    .filter((card) => card.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return cards.slice(0, filters.limit ?? 25);
}

export interface StudioActionInput {
  companyId: number;
  action: 'interesting' | 'not_interesting' | 'contacted' | 'blacklist' | 'snooze';
  note?: string | null;
  days?: number;
  channel?: string;
  templateUsed?: string | null;
}

const STATUS_BY_ACTION: Record<StudioActionInput['action'], string> = {
  interesting: 'interesting',
  not_interesting: 'rejected_by_me',
  contacted: 'contacted',
  blacklist: 'blacklist',
  snooze: 'snoozed',
};

/** Дії над студією: те саме, що на картці вакансії, але без привʼязки до вакансії. */
export async function applyStudioAction(input: StudioActionInput): Promise<{ status: string; outreachId: number | null }> {
  const db = getDb();
  const status = STATUS_BY_ACTION[input.action];
  if (!status) throw new Error(`невідома дія: ${input.action}`);

  const snoozedUntil = input.action === 'snooze' ? Date.now() + (input.days ?? 30) * 86_400_000 : null;
  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, input.companyId));

  if (existing) {
    await db
      .update(companyState)
      .set({ status, snoozedUntil, reason: input.note ?? existing.reason, updatedAt: Date.now() })
      .where(eq(companyState.companyId, input.companyId));
  } else {
    await db
      .insert(companyState)
      .values({ companyId: input.companyId, status, snoozedUntil, reason: input.note ?? null });
  }

  let outreachId: number | null = null;
  if (input.action === 'contacted') {
    const [row] = await db
      .insert(outreach)
      .values({
        companyId: input.companyId,
        vacancyId: null,
        channel: input.channel ?? 'email',
        templateUsed: input.templateUsed ?? 'studio_pitch',
        note: input.note ?? null,
      })
      .returning({ id: outreach.id });
    outreachId = row!.id;
  }

  return { status, outreachId };
}

/** Компанії, які варто обійти першими: високий рахунок і ще не обходились. */
export async function studiosToEnrich(limit = 25): Promise<Company[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(companies)
    .where(and(isNull(companies.lastChecked), notInArray(companies.careersKind, ['none'])))
    .orderBy(desc(companies.firstSeen))
    .limit(limit);
  return rows;
}
