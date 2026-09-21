import { and, desc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, outreach, vacancies, type Company } from '../db/schema.js';
import { scoreCompany, type CompanyBreakdown } from './company-score.js';
import { rules } from './rules.js';
import { HIDDEN_STATUSES } from './queue.js';

/**
 * The studio queue: who to write to with an offer of services. No vacancy is needed here, so this
 * is a list separate from the vacancy queue, with the same actions on company state.
 */

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  kind: string;
  /** Signs of life on the site. null means enrichment has not been there yet. */
  copyrightYear: number | null;
  lastPostAt: number | null;
  tags: string[];
  techHints: string[];
  /** Catalog reputation. null means the catalog did not show it. */
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  /** The "Other" block: everything the catalog showed beyond the listed fields. */
  extra: Record<string, string>;
  description: string | null;
  careersUrl: string | null;
  /** The company page in the catalog it came from. */
  sourceUrl: string | null;
  sources: string[];
  status: string;
  openVacancies: number;
  score: number;
  why: { reason: string; weight: number }[];
  /** `id` is there so the contact can be edited right from the card. */
  contacts: {
    id: number;
    name: string | null;
    role: string | null;
    email: string | null;
    /** false means a hard bounce: the address stays but must not be written to. */
    emailValid: boolean;
  }[];
  lastContactedAt: number | null;
}

export interface StudioFilters {
  limit?: number;
  minScore?: number;
  /** Show everyone, including those already contacted. */
  includeContacted?: boolean;
  country?: string;
  search?: string;
  /** studio | design | startup | product | outstaff. Empty means everything except product companies. */
  kind?: string;
  /** Only those with a named contact. A letter to hello@ is read by a manager, not a tech lead. */
  withNamedContact?: boolean;
  /** Minimum catalog rating. Companies without a rating count as not passing. */
  minRating?: number;
}

export interface StudioPage {
  cards: StudioCard[];
  /** How many companies got a score after the search and country filters. */
  total: number;
  /** How many of them cleared the threshold. The difference from total is what the threshold hid. */
  aboveThreshold: number;
  threshold: number;
}

/**
 * Score every company that passes the filters, with no threshold and no limit. The split between
 * this function and `studioPage` lets the interface say not only how many studios are shown but
 * also how many the threshold hid: without that an empty list looks like broken collection,
 * although the database has companies.
 */
async function scoreAll(filters: StudioFilters): Promise<StudioCard[]> {
  const db = getDb();
  const now = Date.now();

  /*
   * Selection is done by SQL, not JavaScript.
   *
   * The whole companies table and the whole contacts table used to be read here, with the filters
   * applied in memory. At two thousand companies that still worked, but the cost did not depend on
   * the query: a search for "design" that leaves fifty rows cost exactly as much as an empty list.
   * And since the search field sent a request per letter, one word cost six such passes.
   *
   * Now JavaScript receives already filtered rows, and the cost of a query finally depends on how
   * many rows it actually asks for.
   */
  const conditions = [
    // A company without a domain leads nowhere: no letter, no site, no crawl.
    ne(companies.domain, ''),
    filters.country ? eq(companies.country, filters.country) : undefined,
    /*
     * Without an explicit kind, product companies are removed from the list: a cold "I can help
     * with your project" letter does not work for them, they have the vacancy Queue.
     */
    filters.kind ? eq(companies.kind, filters.kind) : ne(companies.kind, 'product'),
    filters.minRating === undefined
      ? undefined
      : sql`coalesce(${companies.rating}, 0) >= ${filters.minRating}`,
    // A snoozed company is not shown until the snooze ends.
    sql`(${companyState.snoozedUntil} is null or ${companyState.snoozedUntil} <= ${now})`,
    filters.includeContacted
      ? sql`coalesce(${companyState.status}, 'new') <> 'blacklist'`
      : notInArray(sql`coalesce(${companyState.status}, 'new')`, HIDDEN_STATUSES),
  ];

  if (filters.search) {
    /*
     * Tags sit in the column as a JSON array, and the search runs over it as a string. That is a bit
     * broader than matching elements in memory: a match can fall across the boundary of two tags.
     * The price of that imprecision is one extra company in the list, and the gain is that the rest
     * of the database is not loaded into memory for one word.
     */
    const needle = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${companies.name}) like ${needle}
        or lower(${companies.domain}) like ${needle}
        or lower(${companies.tags}) like ${needle})`,
    );
  }

  const where = and(...conditions.filter(Boolean));

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
    .where(where);

  /*
   * Contacts come through the same selection, as a subquery rather than a list of ids.
   *
   * A list of ids for two thousand companies is two thousand parameters in one query, and sooner or
   * later it hits the driver's ceiling. A subquery has no such ceiling and behaves on D1 the same
   * way as locally.
   *
   * SQL sets the order: named contacts before generic mailboxes, because a letter to hello@ is read
   * by a manager, section 9 of CLAUDE.md.
   */
  const chosen = db
    .select({ id: companies.id })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(where);

  const contactRows = await db
    .select()
    .from(contacts)
    .where(sql`${contacts.companyId} in ${chosen}`)
    .orderBy(sql`${contacts.name} is null`, contacts.name);

  const byCompany = new Map<number, typeof contactRows>();
  for (const row of contactRows) {
    // push rather than a new array: a copy per contact is wasted work exactly where there is the
    // most of it, at companies with a long list of people.
    const list = byCompany.get(row.companyId);
    if (list) list.push(row);
    else byCompany.set(row.companyId, [row]);
  }

  const cards = rows
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
        kind: row.company.kind,
        copyrightYear: row.company.copyrightYear,
        lastPostAt: row.company.lastPostAt,
        tags: row.company.tags,
        techHints: row.company.techHints,
        rating: row.company.rating,
        reviewsCount: row.company.reviewsCount,
        minProject: row.company.minProject,
        hourlyRate: row.company.hourlyRate,
        foundedYear: row.company.foundedYear,
        extra: row.company.extra ?? {},
        description: row.company.description,
        careersUrl: row.company.careersUrl,
        sourceUrl: row.company.sourceUrl,
        sources: row.company.sources,
        status: row.status ?? 'new',
        openVacancies: row.openVacancies,
        score: breakdown.score,
        why: [...breakdown.positives, ...breakdown.negatives].sort((a, b) => b.weight - a.weight),
        contacts: (byCompany.get(row.company.id) ?? []).map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.role,
          email: contact.email,
          emailValid: contact.emailValid,
        })),
        lastContactedAt: row.lastContactedAt,
      } satisfies StudioCard;
    })
    .sort((a, b) => b.score - a.score);

  return cards;
}

/** A page of the studio list together with counters for the interface. */
export async function studioPage(filters: StudioFilters = {}): Promise<StudioPage> {
  const threshold = filters.minScore ?? rules().companies.threshold;
  const all = await scoreAll(filters);
  const passing = all
    .filter((card) => card.score >= threshold)
    .filter((card) => !filters.withNamedContact || card.contacts.some((contact) => contact.name));

  return {
    cards: passing.slice(0, filters.limit ?? 1000),
    total: all.length,
    aboveThreshold: passing.length,
    threshold,
  };
}

/** A thin wrapper for tests and for callers that need only the list. */
export async function studioQueue(filters: StudioFilters = {}): Promise<StudioCard[]> {
  return (await studioPage(filters)).cards;
}

export interface StudioActionInput {
  companyId: number;
  action: 'interesting' | 'not_interesting' | 'contacted' | 'blacklist' | 'snooze';
  note?: string | null;
  days?: number;
  channel?: string;
  /** A contact snapshot at send time. Needed so that a year later it is clear who was written to. */
  contactName?: string | null;
  contactEmail?: string | null;
  templateUsed?: string | null;
}

const STATUS_BY_ACTION: Record<StudioActionInput['action'], string> = {
  interesting: 'interesting',
  not_interesting: 'rejected_by_me',
  contacted: 'contacted',
  blacklist: 'blacklist',
  snooze: 'snoozed',
};

/** Actions on a studio: the same as on a vacancy card, but without a vacancy. */
export async function applyStudioAction(input: StudioActionInput): Promise<{ status: string; outreachId: number | null }> {
  const db = getDb();
  const status = STATUS_BY_ACTION[input.action];
  if (!status) throw new Error(`unknown action: ${input.action}`);

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
        status: 'sent',
        sentAt: Date.now(),
        templateUsed: input.templateUsed ?? 'studio_pitch',
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        note: input.note ?? null,
      })
      .returning({ id: outreach.id });
    outreachId = row!.id;
  }

  return { status, outreachId };
}

/** Companies worth crawling first: a high score and never crawled yet. */
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
