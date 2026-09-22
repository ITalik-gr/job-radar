import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies } from '../db/schema.js';
import { log } from '../lib/log.js';

/**
 * Move the rate and minimum project size out of the tags and into their own columns.
 *
 * Before the columns existed, catalogs put "$50 - $99 / hr" and "$10,000+" right in
 * the tags, next to services. This shows up as noise in the tag filter, and the new
 * filters and CSV export read the columns, which are empty for already collected companies.
 *
 * There's no need to re-collect the catalogs just for this: the data is already in the
 * database, it just needs sorting into place. The rating and review count can't be
 * recovered this way, they were never in the tags, so they will only appear on a fresh collection.
 */

/**
 * "$50 - $99 / hr", "$50-$99/hr", "< $25 / hr", "$300+ / hr". The dash can be a regular
 * hyphen, an en dash or an em dash, and catalogs write the range bounds with both a
 * less-than sign and a plus.
 */
const RATE = /^[<>]?\s?\$\s?\d[\d,]*\s*(?:(?:[-–—]|to)\s*\$?\d[\d,]*)?\+?\s*\/?\s*hr\.?$/i;
/** "$10,000+", "$5,000+". Without "/hr", otherwise it's a rate. */
const MIN_PROJECT = /^\$\s?\d[\d,]*\+$/;
/** "Founded 2015", "Since 2009". */
const FOUNDED = /^(?:founded|established|since)\D{0,4}(19\d{2}|20\d{2})$/i;

/**
 * Noise that catalogs hand over together with services. These aren't tags: they're
 * chart labels ("Allocation of expertise by %"), rating scores ("9.5/10 Market Presence"),
 * buttons ("Was this helpful?") and review counters. They get in the way in the tag
 * filter, carry no weight in scoring, and just take up space on the card.
 */
const TAG_NOISE = [
  /^allocation of expertise/i,
  /^was this helpful/i,
  /^service focus\b/i,
  /^\d+(?:\.\d+)?\/\d+\b/,
  /reviews? mention/i,
  /^\d[\d,]*\s*reviews?$/i,
  /^(see|show|read|view)\b/i,
  // After stripping a leading percentage, any percent sign left inside means it's a
  // chart label, not a service name: "Web Design 45% Other" is the tail of "Service focus 50% ...".
  /\d+%/,
  /^\+?\d+\s*services?$/i,
];

/** "25% Web Development" is the same service, just with a chart percentage tacked on in front. */
function cleanTag(tag: string): string {
  return tag
    .trim()
    .replace(/^\d+(?:\.\d+)?%\s*/, '')
    .replace(/\s*\+\d+\s*services?$/i, '')
    .trim();
}

export interface BackfillStats {
  /** How many companies were reviewed. */
  seen: number;
  rate: number;
  minProject: number;
  founded: number;
  /** How many tags were removed because they moved into columns or turned out to be noise. */
  tagsRemoved: number;
}

/** Clean up one company's tags: strip percentages, remove noise, collapse duplicates. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const tag = cleanTag(raw);
    if (!tag || tag.length < 2) continue;
    if (TAG_NOISE.some((pattern) => pattern.test(tag))) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  return result;
}

export async function backfillCatalogFields(): Promise<BackfillStats> {
  const db = getDb();
  const rows = await db.select().from(companies);
  const stats: BackfillStats = { seen: rows.length, rate: 0, minProject: 0, founded: 0, tagsRemoved: 0 };

  for (const row of rows) {
    const rate = row.tags.find((tag) => RATE.test(tag.trim()));
    const minProject = row.tags.find((tag) => MIN_PROJECT.test(tag.trim()));
    const founded = row.tags.map((tag) => FOUNDED.exec(tag.trim())).find(Boolean);

    // Don't touch what's already filled in: a fresh collection is more accurate than a tag that's been sitting there for years.
    const nextRate = row.hourlyRate ?? rate ?? null;
    const nextMinProject = row.minProject ?? minProject ?? null;
    const nextFounded = row.foundedYear ?? (founded ? Number(founded[1]) : null);

    const tags = cleanTags(
      row.tags.filter((tag) => tag !== rate && tag !== minProject && tag !== founded?.[0]),
    );
    const removed = row.tags.length - tags.length;

    if (
      nextRate === row.hourlyRate &&
      nextMinProject === row.minProject &&
      nextFounded === row.foundedYear &&
      removed === 0 &&
      tags.join('|') === row.tags.join('|')
    ) {
      continue;
    }

    if (!row.hourlyRate && rate) stats.rate += 1;
    if (!row.minProject && minProject) stats.minProject += 1;
    if (!row.foundedYear && founded) stats.founded += 1;
    stats.tagsRemoved += removed;

    await db
      .update(companies)
      .set({ hourlyRate: nextRate, minProject: nextMinProject, foundedYear: nextFounded, tags })
      .where(eq(companies.id, row.id));
  }

  log.info(stats, 'catalog fields sorted into columns');
  return stats;
}
