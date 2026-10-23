import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, contacts, leads, type Lead } from '../db/schema.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import type { RawContact, RawLead } from '../sources/registry.js';
import { upsertCompany } from './companies.js';

/**
 * Explicit demand, section 3 of CLAUDE.md: tenders, funding rounds, public requests. A lead hangs
 * off the company that has the demand, and keeps its own deadline.
 */

export interface LeadStats {
  /** Records the source returned; in a run, before the source's own filter. */
  itemsFound: number;
  /** New leads. */
  itemsNew: number;
  updated: number;
  /** New companies the leads brought. */
  companiesNew: number;
  contactsNew: number;
  errors: string[];
}

/**
 * A contact a lead source published. Matched by address, or by phone when there is no address;
 * an existing row only gets its empty fields filled.
 */
async function rememberLeadContact(companyId: number, contact: RawContact): Promise<boolean> {
  if (!contact.email && !contact.phone) return false;
  const db = getDb();
  const [existing] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.companyId, companyId),
        contact.email ? eq(contacts.email, contact.email) : eq(contacts.phone, contact.phone!),
      ),
    );

  if (existing) {
    await db
      .update(contacts)
      .set({
        name: existing.name ?? contact.name,
        role: existing.role ?? contact.role,
        phone: existing.phone ?? contact.phone,
      })
      .where(eq(contacts.id, existing.id));
    return false;
  }

  await db.insert(contacts).values({
    companyId,
    name: contact.name,
    role: contact.role,
    email: contact.email,
    phone: contact.phone,
    emailValid: true,
  });
  return true;
}

export async function saveLeads(items: RawLead[]): Promise<LeadStats> {
  const db = getDb();
  const stats: LeadStats = { itemsFound: items.length, itemsNew: 0, updated: 0, companiesNew: 0, contactsNew: 0, errors: [] };

  for (const item of items) {
    try {
      let companyId: number | null = null;
      if (item.company) {
        const { company, created } = await upsertCompany({
          ...item.company,
          source: item.source,
          sizeHint: item.company.sizeHint,
          careersUrl: item.company.careersUrl,
        });
        companyId = company.id;
        if (created) stats.companiesNew += 1;
        if (item.contact && (await rememberLeadContact(company.id, item.contact))) stats.contactsNew += 1;
      }

      const [existing] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.source, item.source), eq(leads.externalId, item.externalId)));

      const values = {
        companyId,
        url: item.url,
        title: item.title,
        text: item.text,
        budget: item.budget,
        currency: item.currency,
        deadlineAt: item.deadlineAt,
      };

      if (existing) {
        // A tender gets amended: the deadline moves, the budget changes. The status stays the owner's.
        await db
          .update(leads)
          .set({ ...values, companyId: companyId ?? sql`${leads.companyId}` })
          .where(eq(leads.id, existing.id));
        stats.updated += 1;
      } else {
        await db.insert(leads).values({ ...values, source: item.source, externalId: item.externalId });
        stats.itemsNew += 1;
      }
    } catch (error) {
      const message = `${item.externalId}: ${error instanceof Error ? error.message : String(error)}`;
      stats.errors.push(message);
      log.warn({ source: item.source, err: message }, 'failed to save lead');
    }
  }

  return stats;
}

/** Runs a lead source and saves what it found, with the usual run bookkeeping. */
export async function syncLeads(id: string): Promise<LeadStats> {
  const { getSource } = await import('../sources/registry.js');
  const source = getSource(id);
  if (!source) throw new Error(`unknown source: ${id}`);
  if (source.kind !== 'lead') throw new Error(`source ${id} is not a lead source`);
  return withRun(id, async () => {
    const { leads: found, seen } = await source.fetch({});
    return { ...(await saveLeads(found)), itemsFound: seen };
  });
}

export const LEAD_STATUSES = ['new', 'interesting', 'contacted', 'skipped'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadRow extends Lead {
  companyName: string | null;
  companyDomain: string | null;
}

export interface LeadQuery {
  source?: string;
  status?: LeadStatus;
  /** Open only: no closing date and a deadline in the future or none. Default true. */
  open?: boolean;
  /** Substring of the title, the text or the buyer's name. */
  search?: string;
  /** Budget bounds, in the lead's own currency. A lead without a budget does not pass either bound. */
  minBudget?: number;
  maxBudget?: number;
  /** Minimum model fit, 0 to 100. An unrated lead does not pass. */
  minFit?: number;
  /** Deadline within this many days from now. */
  deadlineDays?: number;
  sort?: 'deadline' | 'budget' | 'fit' | 'new';
  limit?: number;
}

function leadOrder(sort: LeadQuery['sort']) {
  if (sort === 'budget') return [sql`${leads.budget} is null`, desc(leads.budget)];
  if (sort === 'fit') return [sql`${leads.fit} is null`, desc(leads.fit), asc(leads.deadlineAt)];
  if (sort === 'new') return [desc(leads.firstSeen)];
  return [sql`${leads.deadlineAt} is null`, asc(leads.deadlineAt), desc(leads.firstSeen)];
}

/**
 * Leads by deadline, nearest first; leads without a deadline (news) after them, newest first.
 */
export async function listLeads(query: LeadQuery = {}, now = Date.now()): Promise<LeadRow[]> {
  const db = getDb();
  const open = query.open ?? true;
  const rows = await db
    .select({ lead: leads, companyName: companies.name, companyDomain: companies.domain })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .where(
      and(
        query.source ? eq(leads.source, query.source) : undefined,
        query.status ? eq(leads.status, query.status) : undefined,
        open ? and(isNull(leads.closedAt), or(isNull(leads.deadlineAt), gt(leads.deadlineAt, now))) : undefined,
        query.search
          ? sql`(lower(${leads.title}) like ${`%${query.search.toLowerCase()}%`}
              or lower(coalesce(${leads.text}, '')) like ${`%${query.search.toLowerCase()}%`}
              or lower(coalesce(${companies.name}, '')) like ${`%${query.search.toLowerCase()}%`})`
          : undefined,
        query.minBudget === undefined ? undefined : sql`${leads.budget} >= ${query.minBudget}`,
        query.maxBudget === undefined ? undefined : sql`${leads.budget} <= ${query.maxBudget}`,
        query.minFit === undefined ? undefined : sql`${leads.fit} >= ${query.minFit}`,
        query.deadlineDays === undefined
          ? undefined
          : sql`${leads.deadlineAt} is not null and ${leads.deadlineAt} <= ${now + query.deadlineDays * 86_400_000}`,
      ),
    )
    .orderBy(...leadOrder(query.sort))
    .limit(query.limit ?? 500);

  return rows.map((row) => ({ ...row.lead, companyName: row.companyName, companyDomain: row.companyDomain }));
}

export async function setLeadStatus(
  id: number,
  status: LeadStatus,
): Promise<{ id: number; before: string; after: string }> {
  if (!LEAD_STATUSES.includes(status)) throw new Error(`unknown lead status: ${status}`);
  const db = getDb();
  const [existing] = await db.select().from(leads).where(eq(leads.id, id));
  if (!existing) throw new Error(`no lead ${id}`);
  await db.update(leads).set({ status }).where(eq(leads.id, id));
  return { id, before: existing.status, after: status };
}

/** Every lead source in turn, for the daily schedule. One failing source does not stop the rest. */
export async function syncAllLeads(): Promise<Record<string, LeadStats | { error: string }>> {
  const { listSources } = await import('../sources/registry.js');
  const result: Record<string, LeadStats | { error: string }> = {};
  for (const source of listSources('lead')) {
    try {
      result[source.id] = await syncLeads(source.id);
    } catch (error) {
      result[source.id] = { error: error instanceof Error ? error.message : String(error) };
      log.warn({ source: source.id, err: String(error) }, 'lead source failed');
    }
  }
  return result;
}
