import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, type Company } from '../db/schema.js';
import { log } from '../lib/log.js';
import { normalizeDomain } from '../lib/normalize.js';
import type { RawVacancy } from '../sources/registry.js';
import { upsertCompany } from './companies.js';

/**
 * The hiring signal. This is all that is left of vacancies (CLAUDE.md section 10).
 *
 * A board pass no longer stores postings, classifies them or queues them. It answers one
 * question per company: is this team hiring developers right now. A team that needs hands is a
 * team that might take a contractor, and boards like HN, Getro or DOU are also how new
 * companies with a founder behind them reach the database.
 */

/** A role a contractor developer could do instead. Checked on the title only. */
const DEV_ROLE =
  /\b(developer|engineer|programmer|front[\s-]?end|back[\s-]?end|full[\s-]?stack|web|software|react|node|typescript|next\.?js|розробник|програміст|інженер)\b/i;

/** Titles that look technical but are not development work. */
const NOT_DEV =
  /\b(sales|account|recruit|marketing|support|customer|success|designer|data scientist|qa|test|manager|director|analyst|devops|sre|security|hardware|mechanical|electrical)\b/i;

export function isDevRole(title: string | null | undefined): boolean {
  if (!title) return false;
  return DEV_ROLE.test(title) && !NOT_DEV.test(title);
}

/** After this long without a fresh posting the signal no longer counts. */
export const HIRING_FRESH_DAYS = 45;

export function hiringNow(company: Pick<Company, 'hiringDevs' | 'hiringSeenAt'>, now = Date.now()): boolean {
  if (!company.hiringDevs || !company.hiringSeenAt) return false;
  return now - company.hiringSeenAt < HIRING_FRESH_DAYS * 86_400_000;
}

export interface HiringStats {
  seen: number;
  /** Companies the pass touched. */
  companies: number;
  /** Companies created by this pass. */
  created: number;
  /** Companies with at least one developer role. */
  hiring: number;
  /** Postings with no recognisable company: no domain, no known name. */
  skipped: number;
}

async function resolveCompany(
  item: RawVacancy,
  fallback?: Company,
): Promise<{ company: Company; created: boolean } | null> {
  if (fallback) return { company: fallback, created: false };
  const db = getDb();
  const domain = item.companyDomain ? normalizeDomain(item.companyDomain) : null;
  if (domain) {
    const [byDomain] = await db.select().from(companies).where(eq(companies.domain, domain));
    if (byDomain) return { company: byDomain, created: false };
  }
  if (item.companyName) {
    // RSS-like sources give a name without a domain, so only an exact name match is trusted.
    const [byName] = await db.select().from(companies).where(eq(companies.name, item.companyName));
    if (byName) return { company: byName, created: false };
  }

  /*
   * A company is created only with both a name and a domain. A domain is never invented from
   * the board URL, otherwise every Djinni posting would become one company "djinni.co".
   */
  if (domain && item.companyName) {
    const { company, created } = await upsertCompany({
      name: item.companyName,
      domain,
      source: item.source,
      sourceUrl: item.url,
    });
    return { company, created };
  }
  return null;
}

/**
 * Folds a board response into companies: one row per company, the count of developer roles
 * and when they were last seen. A company with postings but no developer role keeps its old
 * signal untouched: a sales opening says nothing either way.
 */
export async function recordHiring(
  items: RawVacancy[],
  company?: Company,
  now = Date.now(),
): Promise<HiringStats> {
  const db = getDb();
  const stats: HiringStats = { seen: items.length, companies: 0, created: 0, hiring: 0, skipped: 0 };
  const roles = new Map<number, { company: Company; dev: number }>();

  for (const item of items) {
    const owner = await resolveCompany(item, company);
    if (!owner) {
      stats.skipped += 1;
      continue;
    }
    if (owner.created) stats.created += 1;
    const entry = roles.get(owner.company.id) ?? { company: owner.company, dev: 0 };
    if (isDevRole(item.title)) entry.dev += 1;
    roles.set(owner.company.id, entry);
  }

  for (const { company: row, dev } of roles.values()) {
    stats.companies += 1;
    if (dev === 0) continue;
    stats.hiring += 1;
    await db
      .update(companies)
      .set({ hiringDevs: true, hiringRoles: dev, hiringSeenAt: now })
      .where(eq(companies.id, row.id));
  }

  /*
   * An ATS pass for one known company that found no developer role is a real "not hiring":
   * the board is theirs and it is complete. For aggregated boards absence means nothing.
   */
  if (company && !roles.get(company.id)?.dev) {
    await db
      .update(companies)
      .set({ hiringDevs: false, hiringRoles: 0 })
      .where(eq(companies.id, company.id));
  }

  log.info({ ...stats }, 'hiring signal recorded');
  return stats;
}
