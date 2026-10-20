import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { detectKind } from './company-kind.js';
import { companies, companyState, type Company } from '../db/schema.js';
import { normalizeDomain, normalizeUrl } from '../lib/normalize.js';

export interface CompanyInput {
  name: string;
  domain: string;
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

const UA_COUNTRY = new Set(['ua', 'ukraine', 'україна', 'украина']);

/** ua | intl | null. Null when the country is unknown: a guess here would skew every UA filter. */
export function marketOf(country: string | null | undefined): 'ua' | 'intl' | null {
  const value = (country ?? '').trim().toLowerCase();
  if (!value) return null;
  return UA_COUNTRY.has(value) ? 'ua' : 'intl';
}

export interface UpsertResult {
  company: Company;
  created: boolean;
}

/**
 * A company is identified by its domain. Re-importing the same domain doesn't create
 * a duplicate, it appends the source and fills in empty fields. Existing data is never overwritten.
 */
export async function upsertCompany(input: CompanyInput): Promise<UpsertResult> {
  const db = getDb();
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error(`invalid domain: ${input.domain}`);

  const [existing] = await db.select().from(companies).where(eq(companies.domain, domain));

  if (!existing) {
    const [created] = await db
      .insert(companies)
      .values({
        name: input.name.trim(),
        domain,
        country: input.country ?? null,
        market: marketOf(input.country),
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
      country: existing.country ?? input.country ?? null,
      market: marketOf(existing.country ?? input.country),
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
