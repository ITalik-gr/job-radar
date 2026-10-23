import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, leads as leadsTable, outreach, siteAudits, type Company } from '../db/schema.js';
import { scoreCompany, type CompanyBreakdown } from './company-score.js';
import { filterConditions, type CompanyFilter } from './filters.js';
import { hiringNow } from './hiring.js';
import { rules } from './rules.js';

/**
 * Statuses that keep a company out of the lead list: already written to, answered, turned
 * down, blocked. A snooze is handled separately by its end date.
 */
export const HIDDEN_STATUSES = ['contacted', 'replied', 'rejected_by_me', 'rejected_by_them', 'blacklist'];

/**
 * The lead list: who to write to with an offer of services, scored and filtered. The name is
 * historical, it covers every segment now, not only studios.
 */

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  kind: string;
  market: string | null;
  industry: string | null;
  phone: string | null;
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
  careersKind: string;
  /** The company page in the catalog it came from. */
  sourceUrl: string | null;
  sources: string[];
  firstSeen: number;
  /** The last enrichment pass over the site. */
  lastChecked: number | null;
  status: string;
  snoozedUntil: number | null;
  /** Hiring developers right now, and how many roles were seen. */
  hiring: boolean;
  hiringRoles: number | null;
  /** The model's fit read, see `fit.ts`. Null until asked. */
  fit: number | null;
  fitService: string | null;
  fitStage: string | null;
  score: number;
  why: { reason: string; weight: number }[];
  /** `id` is there so the contact can be edited right from the card. */
  contacts: {
    id: number;
    name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
    /** false means a hard bounce: the address stays but must not be written to. */
    emailValid: boolean;
  }[];
  /** The latest site audit, null when the site was never audited. */
  audit: { checkedAt: number; perfScore: number | null; issues: string[] } | null;
  lastContactedAt: number | null;
}

/**
 * The lead list and the directory share one query. `leads` (the default) is the working list: it
 * applies the score threshold and hides companies already handled, product companies and active
 * snoozes unless the filter asks for them. `all` is the directory: the filter and nothing else.
 */
export interface StudioFilters extends CompanyFilter {
  limit?: number;
  scope?: 'leads' | 'all';
  sort?: 'score' | 'name';
  /** Internal: only these companies. Not part of the shared filter shape. */
  ids?: number[];
  domain?: string;
}

export interface StudioPage {
  cards: StudioCard[];
  /** How many companies matched the filter before score and hiring were applied. */
  total: number;
  /** How many of them passed score and hiring. The difference from total is what the threshold hid. */
  aboveThreshold: number;
  /** The minimum score applied, null in the directory without one. */
  threshold: number | null;
}

/**
 * Score every company that passes the SQL half of the filter, with no threshold and no limit. The
 * split from `studioPage` lets the interface say how many the threshold hid: without that an empty
 * list looks like broken collection, although the database has companies.
 */
async function scoreAll(filters: StudioFilters): Promise<StudioCard[]> {
  const db = getDb();
  const now = Date.now();
  const leads = (filters.scope ?? 'leads') === 'leads';

  /*
   * Selection is done by SQL, not JavaScript, so the cost of a query depends on how many rows it
   * asks for rather than on the size of the database.
   */
  const { ids, domain, ...shared } = filters;
  const conditions = filterConditions(shared);
  if (ids) conditions.push(inArray(companies.id, ids));
  if (domain) conditions.push(eq(companies.domain, domain));
  if (leads) {
    /*
     * A business without a site is a lead too ("you have no site", section 5), but only when it
     * can be reached: without a site there is nothing to crawl an address from later.
     */
    if (filters.hasSite === undefined) {
      conditions.push(
        sql`(${companies.domain} <> '' or ${companies.phone} is not null or exists (
          select 1 from ${contacts} where ${contacts.companyId} = ${companies.id}
          and (${contacts.email} is not null or ${contacts.phone} is not null)))`,
      );
    }
    /*
     * Without an explicit kind, product companies are removed from the list: a cold "I can help
     * with your project" letter rarely works on a company with its own engineering department.
     */
    if (!filters.kind) conditions.push(ne(companies.kind, 'product'));
    if (!filters.status) {
      conditions.push(
        filters.includeContacted
          ? sql`coalesce(${companyState.status}, 'new') <> 'blacklist'`
          : notInArray(sql`coalesce(${companyState.status}, 'new')`, HIDDEN_STATUSES),
      );
    }
    // A snoozed company is not shown until the snooze ends, unless snoozed ones are asked for.
    if (!filters.status?.includes('snoozed')) {
      conditions.push(sql`(${companyState.snoozedUntil} is null or ${companyState.snoozedUntil} <= ${now})`);
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      company: companies,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      lastContactedAt: sql<number | null>`(
        select max(${outreach.sentAt}) from ${outreach} where ${outreach.companyId} = ${companies.id}
      )`,
    })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(where);

  /*
   * Contacts and audits come through the same selection, as a subquery rather than a list of ids:
   * two thousand ids is two thousand parameters, past what D1 takes in one query.
   *
   * SQL sets the contact order: named contacts before generic mailboxes, because a letter to
   * hello@ is read by a manager, section 5 of CLAUDE.md.
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
    const list = byCompany.get(row.companyId);
    if (list) list.push(row);
    else byCompany.set(row.companyId, [row]);
  }

  const auditRows = await db
    .select({
      companyId: siteAudits.companyId,
      checkedAt: siteAudits.checkedAt,
      perfScore: siteAudits.perfScore,
      mobileOk: siteAudits.mobileOk,
      cms: siteAudits.cms,
      issues: siteAudits.issues,
    })
    .from(siteAudits)
    .where(sql`${siteAudits.companyId} in ${chosen}`)
    .orderBy(desc(siteAudits.checkedAt));

  const latestAudit = new Map<number, (typeof auditRows)[number]>();
  for (const row of auditRows) if (!latestAudit.has(row.companyId)) latestAudit.set(row.companyId, row);

  // Open tenders with the deadline ahead, the nearest per company.
  const leadRows = await db
    .select({ companyId: leadsTable.companyId, title: leadsTable.title })
    .from(leadsTable)
    .where(
      and(
        sql`${leadsTable.companyId} in ${chosen}`,
        isNull(leadsTable.closedAt),
        ne(leadsTable.status, 'skipped'),
        sql`(${leadsTable.deadlineAt} is null or ${leadsTable.deadlineAt} > ${now})`,
        // A tender the model rated as not for a solo developer is not demand worth a score.
        sql`(${leadsTable.fit} is null or ${leadsTable.fit} >= ${rules().companies.minLeadFit})`,
      ),
    )
    .orderBy(sql`coalesce(${leadsTable.deadlineAt}, 9e15)`);

  const openLead = new Map<number, { title: string }>();
  for (const row of leadRows) if (row.companyId && !openLead.has(row.companyId)) openLead.set(row.companyId, row);

  const cards = rows
    .map((row) => {
      const audit = latestAudit.get(row.company.id);
      const breakdown: CompanyBreakdown = scoreCompany({
        company: row.company,
        status: row.status,
        audit: audit ?? null,
        openLead: openLead.get(row.company.id) ?? null,
        contacts: byCompany.get(row.company.id) ?? [],
        now,
      });

      return {
        companyId: row.company.id,
        name: row.company.name,
        domain: row.company.domain,
        country: row.company.country,
        city: row.company.city,
        sizeHint: row.company.sizeHint,
        kind: row.company.kind,
        market: row.company.market,
        industry: row.company.industry,
        phone: row.company.phone,
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
        careersKind: row.company.careersKind,
        sourceUrl: row.company.sourceUrl,
        sources: row.company.sources,
        firstSeen: row.company.firstSeen,
        lastChecked: row.company.lastChecked,
        status: row.status ?? 'new',
        snoozedUntil: row.snoozedUntil,
        hiring: hiringNow(row.company, now),
        hiringRoles: row.company.hiringRoles,
        fit: row.company.fit,
        fitService: row.company.fitService,
        fitStage: row.company.fitStage,
        score: breakdown.score,
        why: [...breakdown.positives, ...breakdown.negatives].sort((a, b) => b.weight - a.weight),
        contacts: (byCompany.get(row.company.id) ?? []).map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.role,
          email: contact.email,
          phone: contact.phone,
          emailValid: contact.emailValid,
        })),
        audit: audit ? { checkedAt: audit.checkedAt, perfScore: audit.perfScore, issues: audit.issues } : null,
        lastContactedAt: row.lastContactedAt,
      } satisfies StudioCard;
    })
    .sort((a, b) => (filters.sort === 'name' ? a.name.localeCompare(b.name) : b.score - a.score));

  return cards;
}

/** How much of the description a list row carries: one line under the name. */
const SUMMARY_CHARS = 180;

/** The reasons a row shows as chips: demand, no site, a named contact. The rest is on the company page. */
const ROW_REASONS = /^(open tender|no site|named contact)/;

/** Reasons that only say who a company is, not why to write: the row falls back past them. */
const GENERIC_REASONS = /^(size |kind: |country |model fit)/;

/**
 * A card as a list row needs it. The directory on the worker holds thousands of companies, and
 * full cards came to about 7 MB of JSON per page open. A row shows a line of description, the
 * reason to write, reach and a few tags; the company page fetches the full card. `slim` marks it,
 * so a trimmed card is never taken for the whole one.
 */
export function slimCard(card: StudioCard) {
  const positives = card.why.filter((item) => item.weight > 0);
  return {
    slim: true as const,
    companyId: card.companyId,
    name: card.name,
    domain: card.domain,
    country: card.country,
    city: card.city,
    kind: card.kind,
    market: card.market,
    industry: card.industry,
    phone: card.phone,
    sizeHint: card.sizeHint,
    rating: card.rating,
    reviewsCount: card.reviewsCount,
    description:
      card.description && card.description.length > SUMMARY_CHARS
        ? `${card.description.slice(0, SUMMARY_CHARS).trimEnd()}...`
        : card.description,
    tags: card.tags.slice(0, 12),
    techHints: card.techHints.slice(0, 6),
    status: card.status,
    hiring: card.hiring,
    hiringRoles: card.hiringRoles,
    fit: card.fit,
    fitService: card.fitService,
    fitStage: card.fitStage,
    score: card.score,
    // The strongest telling plus stays too: a row with nothing specific still says why it is listed.
    why: positives.filter((item) => item === positives.find((first) => !GENERIC_REASONS.test(first.reason)) || ROW_REASONS.test(item.reason)),
    contacts: card.contacts.map(({ id, name, role, email, emailValid }) => ({ id, name, role, email, emailValid })),
    audit: card.audit ? { issues: card.audit.issues } : null,
    lastChecked: card.lastChecked,
    lastContactedAt: card.lastContactedAt,
  };
}

/** A page of the list together with counters for the interface. */
export async function studioPage(filters: StudioFilters = {}): Promise<StudioPage> {
  const leads = (filters.scope ?? 'leads') === 'leads';
  const threshold = filters.minScore ?? (leads ? rules().companies.threshold : null);
  const all = await scoreAll(filters);
  const passing = all.filter(
    (card) =>
      (threshold === null || card.score >= threshold) &&
      (filters.maxScore === undefined || card.score <= filters.maxScore) &&
      (filters.hiring === undefined || card.hiring === filters.hiring),
  );

  return {
    cards: passing.slice(0, filters.limit ?? 1000),
    total: all.length,
    aboveThreshold: passing.length,
    threshold,
  };
}

/**
 * One company as a scored card, for the company page: the details endpoint has no score, and the
 * page shows where it comes from. Nothing is hidden here, a blacklisted company still opens.
 *
 * The key is the one the web app keeps in its address: a domain, or `id-42` for a business
 * without a site. An empty key matches nothing, never every company without a domain.
 */
export async function companyCard(key: string): Promise<StudioCard | null> {
  const byId = /^id-(\d+)$/.exec(key);
  if (!byId && !key.trim()) return null;
  const [card] = await scoreAll(
    byId ? { ids: [Number(byId[1])], scope: 'all' } : { domain: key.trim().toLowerCase(), scope: 'all' },
  );
  return card ?? null;
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

/** Actions on a lead card. They write the company state, and "contacted" also logs a letter. */
export async function applyStudioAction(input: StudioActionInput): Promise<{ status: string; outreachId: number | null }> {
  const db = getDb();
  const requested = STATUS_BY_ACTION[input.action];
  if (!requested) throw new Error(`unknown action: ${input.action}`);

  const snoozedUntil = input.action === 'snooze' ? Date.now() + (input.days ?? 30) * 86_400_000 : null;
  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, input.companyId));

  /*
   * "Interesting" on a company already written to must not erase that fact: one click used to
   * turn `contacted` back into `interesting`, and the list then treated it as never contacted.
   */
  const keepContact = requested === 'interesting' && ['contacted', 'replied'].includes(existing?.status ?? '');
  const status = keepContact ? existing!.status : requested;

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
    .where(
      and(isNull(companies.lastChecked), notInArray(companies.careersKind, ['none']), ne(companies.domain, '')),
    )
    .orderBy(desc(companies.firstSeen))
    .limit(limit);
  return rows;
}
