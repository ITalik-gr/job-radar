import type { Company } from '../db/schema.js';

/**
 * The company's kind. Determined deterministically from tags, sources and description, no model.
 *
 * Why: letter scenarios differ. A design studio gets "I could become your
 * developer and you'd expand your services", a startup gets "I was at a startup, I can
 * cover the front end", an outstaff company gets nothing at all. Without a kind, it's all one list.
 */
export type CompanyKind = 'studio' | 'design' | 'startup' | 'product' | 'outstaff' | 'unknown';

export const COMPANY_KINDS: CompanyKind[] = [
  'studio',
  'design',
  'startup',
  'product',
  'outstaff',
  'unknown',
];

const DESIGN_TAGS = [
  'web design',
  'ui/ux design',
  'ux/ui design',
  'graphic design',
  'branding',
  'product design',
  'logo design',
];

const DEV_TAGS = [
  'web development',
  'custom software development',
  'mobile app development',
  'software development',
  'e-commerce development',
  'ai development',
];

const OUTSTAFF_TAGS = ['it staff augmentation', 'staff augmentation', 'outstaffing', 'outsourcing'];

/** Sources that by definition bring in startups. */
const STARTUP_SOURCES = ['getro', 'yc', 'wellfound', 'eu-startups', 'startups.gallery'];

/** Sources that by definition bring in agencies and studios. */
const AGENCY_SOURCES = ['clutch', 'goodfirms', 'designrush', 'sortlist', 'themanifest', 'upcity', 'techbehemoths'];

function has(haystack: string[], needles: string[]): number {
  return haystack.filter((item) => needles.some((needle) => item.includes(needle))).length;
}

/**
 * The order of the rules matters, and it's deliberately this order:
 * a source outweighs tags, because an agency catalog doesn't show startups and vice
 * versa, and only within agencies is design separated from development by tag weight.
 */
export function detectKind(
  company: Pick<Company, 'tags' | 'sources' | 'description' | 'sizeHint'> & { careersKind?: string },
): CompanyKind {
  const sources = (company.sources ?? []).map((item) => item.toLowerCase());
  const tags = (company.tags ?? []).map((item) => item.toLowerCase());
  const text = `${company.description ?? ''}`.toLowerCase();

  if (sources.some((source) => STARTUP_SOURCES.some((known) => source.includes(known)))) return 'startup';

  const outstaff = has(tags, OUTSTAFF_TAGS);
  const design = has(tags, DESIGN_TAGS);
  const dev = has(tags, DEV_TAGS);

  // Outstaff has to be a noticeable share of the profile, not one tag out of twenty.
  if (outstaff > 0 && outstaff >= design && outstaff >= dev) return 'outstaff';
  if (design > 0 && design > dev) return 'design';
  if (dev > 0 || design > 0) return 'studio';

  if (sources.some((source) => AGENCY_SOURCES.some((known) => source.includes(known)))) return 'studio';

  /*
   * A product company is recognized by having its own ATS with no catalog tags.
   * Specifically `careersKind`, not the source: Vercel and Stripe entered the database
   * from a CSV seed, and by source tag alone they'd stay `unknown`, meaning they'd show
   * up in Studios, where a cold letter saying "I can help with a project" is pointless.
   */
  const ats = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio'];
  if (company.careersKind && ats.includes(company.careersKind)) return 'product';

  if (sources.some((source) => ['greenhouse', 'lever', 'ashby', 'rss'].some((known) => source.includes(known)))) {
    return 'product';
  }

  if (/\b(agency|studio|агенц|студі)\b/.test(text)) return 'studio';
  return 'unknown';
}
// NOTE: the regex above intentionally keeps the Ukrainian stems "агенц" (agency) and
// "студі" (studio), since it matches text scraped from Ukrainian-language sites.

/**
 * Set the kind for every company that still has `unknown`. Needed once after the
 * migration, after that the kind sets itself on every `upsertCompany`.
 */
export async function backfillKinds(force = false): Promise<Record<CompanyKind, number>> {
  const { getDb } = await import('../db/client.js');
  const { companies } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  const rows = await db.select().from(companies);
  const counts: Record<CompanyKind, number> = {
    studio: 0,
    design: 0,
    startup: 0,
    product: 0,
    outstaff: 0,
    unknown: 0,
  };

  for (const row of rows) {
    const kind = detectKind(row);
    counts[kind] += 1;
    if (!force && row.kind === kind) continue;
    await db.update(companies).set({ kind }).where(eq(companies.id, row.id));
  }

  return counts;
}
