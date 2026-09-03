import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
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
}

export interface UpsertResult {
  company: Company;
  created: boolean;
}

/**
 * Компанія ідентифікується доменом. Повторний імпорт того самого домену не створює
 * дубль, а дописує джерело і заповнює порожні поля. Наявні дані не перезаписуються.
 */
export async function upsertCompany(input: CompanyInput): Promise<UpsertResult> {
  const db = getDb();
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error(`невалідний домен: ${input.domain}`);

  const [existing] = await db.select().from(companies).where(eq(companies.domain, domain));

  if (!existing) {
    const [created] = await db
      .insert(companies)
      .values({
        name: input.name.trim(),
        domain,
        country: input.country ?? null,
        city: input.city ?? null,
        sizeHint: input.sizeHint ?? null,
        sources: [input.source],
        careersUrl: input.careersUrl ? normalizeUrl(input.careersUrl) : null,
        careersKind: input.careersKind ?? 'unknown',
        careersSlug: input.careersSlug ?? null,
        tags: input.tags ?? [],
        description: input.description ?? null,
        sourceUrl: input.sourceUrl ? normalizeUrl(input.sourceUrl) : null,
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

  const [updated] = await db
    .update(companies)
    .set({
      sources,
      tags,
      description: existing.description ?? input.description ?? null,
      sourceUrl: existing.sourceUrl ?? (input.sourceUrl ? normalizeUrl(input.sourceUrl) : null),
      country: existing.country ?? input.country ?? null,
      city: existing.city ?? input.city ?? null,
      sizeHint: existing.sizeHint ?? input.sizeHint ?? null,
      careersUrl: existing.careersUrl ?? (input.careersUrl ? normalizeUrl(input.careersUrl) : null),
      careersKind:
        existing.careersKind !== 'unknown' ? existing.careersKind : input.careersKind ?? 'unknown',
      careersSlug: existing.careersSlug ?? input.careersSlug ?? null,
    })
    .where(eq(companies.id, existing.id))
    .returning();

  return { company: updated!, created: false };
}

/** Компанії, у яких є slug конкретного ATS. */
export async function companiesForAts(kind: string): Promise<Company[]> {
  const db = getDb();
  const rows = await db.select().from(companies).where(eq(companies.careersKind, kind));
  return rows.filter((row) => Boolean(row.careersSlug));
}
