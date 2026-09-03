import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, vacancies } from '../db/schema.js';
import { funnel } from './actions.js';

/** Аналітика рівно та, що описана в CLAUDE.md, без спроб зробити з неї продукт. */

export interface TechCount {
  tech: string;
  count: number;
}

export async function topTech(days = 90, limit = 30): Promise<TechCount[]> {
  const db = getDb();
  const since = Date.now() - days * 86_400_000;
  const rows = await db
    .select({ stack: vacancies.stack })
    .from(vacancies)
    .where(and(gte(vacancies.firstSeen, since), sql`${vacancies.score} > -100`));

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tech of new Set(row.stack.map((item) => item.toLowerCase().trim()))) {
      if (tech) counts.set(tech, (counts.get(tech) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tech, count]) => ({ tech, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export interface SalaryRow {
  group: string;
  median: number | null;
  count: number;
}

/** Медіанна вилка по грейдах і країнах. Беремо середину вилки, коли є обидві межі. */
export async function medianSalaries(by: 'seniority' | 'country' = 'seniority'): Promise<SalaryRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      seniority: vacancies.seniority,
      country: companies.country,
      min: vacancies.salaryMin,
      max: vacancies.salaryMax,
    })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .where(isNotNull(vacancies.salaryMin));

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = (by === 'seniority' ? row.seniority : row.country) ?? 'невідомо';
    const value = row.max ? (row.min! + row.max) / 2 : row.min!;
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }

  return [...groups.entries()]
    .map(([group, values]) => ({ group, median: median(values), count: values.length }))
    .sort((a, b) => b.count - a.count);
}

export interface LifetimeStats {
  medianDays: number | null;
  closedCount: number;
  ghosts: { id: number; title: string | null; company: string; url: string; days: number }[];
}

/**
 * Час життя вакансії. Різниця first_seen і closed_at це майбутній датасет власника,
 * тому вакансії не видаляються ніколи. Ті, що висять понад 120 днів, підозрілі.
 */
export async function lifetimes(ghostAfterDays = 120): Promise<LifetimeStats> {
  const db = getDb();
  const closed = await db
    .select({ firstSeen: vacancies.firstSeen, closedAt: vacancies.closedAt })
    .from(vacancies)
    .where(isNotNull(vacancies.closedAt));

  const days = closed.map((row) => (row.closedAt! - row.firstSeen) / 86_400_000);

  const openRows = await db
    .select({
      id: vacancies.id,
      title: vacancies.title,
      url: vacancies.url,
      firstSeen: vacancies.firstSeen,
      company: companies.name,
    })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .where(isNull(vacancies.closedAt))
    .orderBy(vacancies.firstSeen);

  const now = Date.now();
  const ghosts = openRows
    .map((row) => ({ ...row, days: Math.floor((now - row.firstSeen) / 86_400_000) }))
    .filter((row) => row.days >= ghostAfterDays)
    .slice(0, 50)
    .map(({ id, title, company, url, days: age }) => ({ id, title, company, url, days: age }));

  return {
    medianDays: median(days),
    closedCount: closed.length,
    ghosts,
  };
}

export interface DayCount {
  day: string;
  count: number;
}

export async function perDay(days = 30): Promise<DayCount[]> {
  const db = getDb();
  const since = Date.now() - days * 86_400_000;
  const rows = await db
    .select({
      day: sql<string>`date(${vacancies.firstSeen} / 1000, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(vacancies)
    .where(gte(vacancies.firstSeen, since))
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`));

  return rows;
}

export async function fullStats() {
  return {
    topTech: await topTech(),
    salariesBySeniority: await medianSalaries('seniority'),
    salariesByCountry: await medianSalaries('country'),
    lifetimes: await lifetimes(),
    perDay: await perDay(),
    funnel: await funnel(),
  };
}
