import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { detectKind } from './company-kind.js';
import {
  companies,
  companyState,
  contacts,
  leads,
  outreach,
  siteAudits,
  type Company,
  type CompanyState,
} from '../db/schema.js';
import { normalizeCountry, normalizeDomain, normalizeUrl } from '../lib/normalize.js';

export interface CompanyInput {
  name: string;
  /** Empty or missing for a business without a site; then `registryCode` or `placeId` is required. */
  domain?: string | null;
  registryCode?: string | null;
  placeId?: string | null;
  country?: string | null;
  city?: string | null;
  sizeHint?: string | null;
  careersUrl?: string | null;
  careersKind?: string | null;
  careersSlug?: string | null;
  source: string;
  note?: string | null;
  tags?: string[];
  description?: string | null;
  sourceUrl?: string | null;
  rating?: number | null;
  reviewsCount?: number | null;
  minProject?: string | null;
  hourlyRate?: string | null;
  foundedYear?: number | null;
  extra?: Record<string, string> | null;
  industry?: string | null;
  phone?: string | null;
  address?: string | null;
  /** The segment, when the source knows it: a business directory knows a clinic is an smb. */
  kind?: string | null;
}

/** ua | intl | null. Null when the country is unknown: a guess here would skew every UA filter. */
export function marketOf(country: string | null | undefined): 'ua' | 'intl' | null {
  const code = normalizeCountry(country);
  if (!code) return null;
  return code === 'UA' ? 'ua' : 'intl';
}

/**
 * The existing company for an input, by the strongest key it carries: the domain, then the state
 * register code, then the Google place. A clinic first seen in Places without a site and later
 * with one stays one company, because the place id still matches.
 */
async function findExisting(domain: string | null, registryCode: string | null, placeId: string | null) {
  const db = getDb();
  if (domain) {
    const [row] = await db.select().from(companies).where(eq(companies.domain, domain));
    if (row) return row;
  }
  if (registryCode) {
    const [row] = await db.select().from(companies).where(eq(companies.registryCode, registryCode));
    if (row) return row;
  }
  if (placeId) {
    const [row] = await db.select().from(companies).where(eq(companies.placeId, placeId));
    if (row) return row;
  }
  return undefined;
}

export interface UpsertResult {
  company: Company;
  created: boolean;
}

/**
 * A company is identified by its domain, or without a site by its register code or place id.
 * Re-importing the same company doesn't create a duplicate, it appends the source and fills in
 * empty fields. Existing data is never overwritten.
 */
export async function upsertCompany(input: CompanyInput): Promise<UpsertResult> {
  const db = getDb();
  const domain = input.domain?.trim() ? normalizeDomain(input.domain) : null;
  if (input.domain?.trim() && !domain) throw new Error(`invalid domain: ${input.domain}`);
  const registryCode = input.registryCode?.trim() || null;
  const placeId = input.placeId?.trim() || null;
  if (!domain && !registryCode && !placeId) throw new Error(`${input.name}: no domain, register code or place id`);
  const country = normalizeCountry(input.country);

  const existing = await findExisting(domain, registryCode, placeId);

  if (!existing) {
    const [created] = await db
      .insert(companies)
      .values({
        name: input.name.trim(),
        domain: domain ?? '',
        registryCode,
        placeId,
        country,
        market: marketOf(country),
        city: input.city ?? null,
        sizeHint: input.sizeHint ?? null,
        industry: input.industry ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        sources: [input.source],
        careersUrl: input.careersUrl ? normalizeUrl(input.careersUrl) : null,
        careersKind: input.careersKind ?? 'unknown',
        careersSlug: input.careersSlug ?? null,
        tags: input.tags ?? [],
        rating: input.rating ?? null,
        reviewsCount: input.reviewsCount ?? null,
        minProject: input.minProject ?? null,
        hourlyRate: input.hourlyRate ?? null,
        foundedYear: input.foundedYear ?? null,
        extra: input.extra ?? {},
        description: input.description ?? null,
        sourceUrl: input.sourceUrl ? normalizeUrl(input.sourceUrl) : null,
        kind:
          input.kind ??
          detectKind({
            tags: input.tags ?? [],
            sources: [input.source],
            description: input.description ?? null,
            sizeHint: input.sizeHint ?? null,
          }),
      })
      .returning();

    await db
      .insert(companyState)
      .values({ companyId: created!.id, status: 'new', reason: input.note ?? null });

    return { company: created!, created: true };
  }

  const sources = existing.sources.includes(input.source)
    ? existing.sources
    : [...existing.sources, input.source];
  const tags = [...new Set([...existing.tags, ...(input.tags ?? [])])];

  /*
   * The kind is recomputed on every update: a company could first arrive from an ATS
   * with no tags, then from a catalog with tags, and only then does it become clear it's a studio.
   * A recomputed "unknown" means no evidence, not a change, so it never erases a kind a source
   * or the owner set: tags cannot tell a clinic is an smb.
   */
  const detected = detectKind({
    tags,
    sources,
    description: existing.description ?? input.description ?? null,
    sizeHint: existing.sizeHint ?? input.sizeHint ?? null,
  });
  const [updated] = await db
    .update(companies)
    .set({
      sources,
      tags,
      kind: input.kind ?? (detected === 'unknown' ? existing.kind : detected),
      description: existing.description ?? input.description ?? null,
      sourceUrl: existing.sourceUrl ?? (input.sourceUrl ? normalizeUrl(input.sourceUrl) : null),
      // A site found later fills the empty domain; a different domain never replaces one.
      domain: existing.domain || domain || '',
      registryCode: existing.registryCode ?? registryCode,
      placeId: existing.placeId ?? placeId,
      country: existing.country ?? country,
      market: marketOf(existing.country ?? country),
      city: existing.city ?? input.city ?? null,
      industry: existing.industry ?? input.industry ?? null,
      phone: existing.phone ?? input.phone ?? null,
      address: existing.address ?? input.address ?? null,
      sizeHint: existing.sizeHint ?? input.sizeHint ?? null,
      careersUrl: existing.careersUrl ?? (input.careersUrl ? normalizeUrl(input.careersUrl) : null),
      careersKind:
        existing.careersKind !== 'unknown' ? existing.careersKind : input.careersKind ?? 'unknown',
      careersSlug: existing.careersSlug ?? input.careersSlug ?? null,
      /*
       * The rating and review count are a current state, not a fact from the first
       * encounter, so a fresh value overwrites the old one. The rest of the fields only
       * fill in what's empty: the founding year and project range don't change, and
       * overwriting them would break things when another catalog shows the same studio
       * with a shorter card.
       */
      rating: input.rating ?? existing.rating,
      reviewsCount: input.reviewsCount ?? existing.reviewsCount,
      minProject: existing.minProject ?? input.minProject ?? null,
      hourlyRate: existing.hourlyRate ?? input.hourlyRate ?? null,
      foundedYear: existing.foundedYear ?? input.foundedYear ?? null,
      // Already saved data wins: two catalogs write the same field differently.
      extra: { ...(input.extra ?? {}), ...existing.extra },
    })
    .where(eq(companies.id, existing.id))
    .returning();

  return { company: updated!, created: false };
}

/** Companies that have a slug for a specific ATS. */
export async function companiesForAts(kind: string): Promise<Company[]> {
  const db = getDb();
  const rows = await db.select().from(companies).where(eq(companies.careersKind, kind));
  return rows.filter((row) => Boolean(row.careersSlug));
}

/**
 * One company with everything hanging off it: the card in the interface and `get_company` over
 * MCP read the same thing. The embedding is left out, a long vector nobody reads.
 */
export async function companyDetail(id: number) {
  const db = getDb();
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (!row) return null;
  const { embedding: _embedding, ...company } = row;

  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, id));

  return {
    company,
    state: state ?? null,
    contacts: await db.select().from(contacts).where(eq(contacts.companyId, id)),
    outreach: await db.select().from(outreach).where(eq(outreach.companyId, id)).orderBy(desc(outreach.sentAt)),
    audits: await db
      .select()
      .from(siteAudits)
      .where(eq(siteAudits.companyId, id))
      .orderBy(desc(siteAudits.checkedAt))
      .limit(5),
    leads: await db.select().from(leads).where(eq(leads.companyId, id)).orderBy(desc(leads.firstSeen)),
  };
}

/** Every status a company can be in, section 3 of CLAUDE.md. */
export const COMPANY_STATUSES = [
  'new',
  'interesting',
  'contacted',
  'replied',
  'rejected_by_me',
  'rejected_by_them',
  'blacklist',
  'snoozed',
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

type StateView = Pick<CompanyState, 'status' | 'reason' | 'snoozedUntil'> | null;

export interface StateChange {
  companyId: number;
  before: StateView;
  after: StateView;
  /** Set when the requested status was not applied, and why. */
  kept: string | null;
}

const view = (row: CompanyState | undefined | null): StateView =>
  row ? { status: row.status, reason: row.reason, snoozedUntil: row.snoozedUntil } : null;

async function writeState(companyId: number, next: NonNullable<StateView>): Promise<CompanyState> {
  const db = getDb();
  const [row] = await db
    .insert(companyState)
    .values({ companyId, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: companyState.companyId, set: { ...next, updatedAt: Date.now() } })
    .returning();
  return row!;
}

/**
 * Set a company status by hand. Returns the state before and after, so a caller (the MCP chat
 * in particular) can show what actually changed.
 *
 * "Interesting" never downgrades a company already written to or answered: that one move used
 * to make the list treat it as never contacted, section 11 of CLAUDE.md.
 */
export async function setCompanyStatus(
  companyId: number,
  input: { status: CompanyStatus; reason?: string | null; days?: number },
): Promise<StateChange> {
  if (!COMPANY_STATUSES.includes(input.status)) throw new Error(`unknown status: ${input.status}`);

  const db = getDb();
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`no company ${companyId}`);

  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, companyId));
  const downgrade = input.status === 'interesting' && ['contacted', 'replied'].includes(existing?.status ?? '');

  const status = downgrade ? existing!.status : input.status;
  const snoozedUntil = status === 'snoozed' ? Date.now() + (input.days ?? 30) * 86_400_000 : null;
  const reason = input.reason ?? existing?.reason ?? null;

  const saved = await writeState(companyId, { status, reason, snoozedUntil });
  return {
    companyId,
    before: view(existing),
    after: view(saved),
    kept: downgrade ? `already ${existing!.status}, a card action never downgrades it` : null,
  };
}

/**
 * A dated note on a company. Notes live in `company_state.reason`, the same field imports and
 * card actions already write, one line per note, newest last. The status does not change.
 */
export async function addCompanyNote(companyId: number, text: string, now = new Date()): Promise<StateChange> {
  const note = text.trim();
  if (!note) throw new Error('an empty note');

  const db = getDb();
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`no company ${companyId}`);

  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, companyId));
  const line = `${now.toISOString().slice(0, 10)}: ${note}`;
  const reason = existing?.reason ? `${existing.reason}\n${line}` : line;

  const saved = await writeState(companyId, {
    status: existing?.status ?? 'new',
    reason,
    snoozedUntil: existing?.snoozedUntil ?? null,
  });
  return { companyId, before: view(existing), after: view(saved), kept: null };
}

export interface BulkInput {
  ids: number[];
  status?: CompanyStatus;
  reason?: string | null;
  days?: number;
  addTags?: string[];
  removeTags?: string[];
}

export interface BulkResult {
  /** Companies whose status or tags actually changed. */
  changed: number;
  /** Companies that kept their status, with why: a card action never downgrades. */
  kept: { companyId: number; reason: string }[];
  missing: number[];
}

/** The most the Companies page sends in one bulk action. A larger set is a mistake, not a workflow. */
export const BULK_LIMIT = 500;

/**
 * Status and tags on many companies at once, from the Companies page. Status goes through
 * `setCompanyStatus`, so the no-downgrade rule holds in bulk too. Tags are compared case
 * insensitively: removing "clinic" removes "Clinic" a catalog wrote.
 */
export async function bulkUpdateCompanies(input: BulkInput): Promise<BulkResult> {
  const ids = [...new Set(input.ids)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) throw new Error('no companies selected');
  if (ids.length > BULK_LIMIT) throw new Error(`at most ${BULK_LIMIT} companies at once`);

  const add = (input.addTags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const remove = new Set((input.removeTags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  if (!input.status && add.length === 0 && remove.size === 0) throw new Error('nothing to change');

  const db = getDb();
  const result: BulkResult = { changed: 0, kept: [], missing: [] };

  for (const id of ids) {
    const [company] = await db.select({ id: companies.id, tags: companies.tags }).from(companies).where(eq(companies.id, id));
    if (!company) {
      result.missing.push(id);
      continue;
    }

    let changed = false;
    if (input.status) {
      const change = await setCompanyStatus(id, { status: input.status, reason: input.reason, days: input.days });
      if (change.kept) result.kept.push({ companyId: id, reason: change.kept });
      else if (change.before?.status !== change.after?.status) changed = true;
    }

    if (add.length > 0 || remove.size > 0) {
      const kept = company.tags.filter((tag) => !remove.has(tag.toLowerCase()));
      const lower = new Set(kept.map((tag) => tag.toLowerCase()));
      const tags = [...kept, ...add.filter((tag) => !lower.has(tag.toLowerCase()))];
      if (JSON.stringify(tags) !== JSON.stringify(company.tags)) {
        await db.update(companies).set({ tags }).where(eq(companies.id, id));
        changed = true;
      }
    }

    if (changed) result.changed += 1;
  }

  return result;
}
