import { eq, isNotNull, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { vacancies } from '../db/schema.js';

/**
 * Stripping the "about the company" block before sending text to the model.
 *
 * All of a company's vacancies share the same intro and the same tail about benefits
 * and equal opportunity. On live data that's 57 percent of the text at Cloudflare and 49
 * at Anthropic. Each such block was paid for as many times as the company had vacancies:
 * the Cloudflare description 313 times.
 *
 * This is item 1 on the "what else can be done" list in COSTS.md, the biggest one left.
 */

/** Below this, a shared part isn't worth stripping: the difference is within the margin of error. */
const MIN_AFFIX = 200;

/** How much text has to be left over. A safeguard against companies with two similar vacancies. */
const MIN_KEPT = 600;

/** Below this number of vacancies, a shared prefix doesn't mean anything. */
const MIN_SAMPLES = 3;

export interface Affixes {
  prefix: number;
  suffix: number;
}

export const NO_AFFIXES: Affixes = { prefix: 0, suffix: 0 };

/**
 * The longest shared prefix and suffix of a set of texts. Compared character by character:
 * a company's vacancy texts match literally, not approximately.
 */
export function commonAffixes(texts: string[]): Affixes {
  const usable = texts.filter((text) => text.length > 0);
  if (usable.length < MIN_SAMPLES) return NO_AFFIXES;

  const shortest = usable.reduce((min, text) => Math.min(min, text.length), Infinity);
  const first = usable[0]!;

  let prefix = 0;
  while (prefix < shortest && usable.every((text) => text[prefix] === first[prefix])) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    usable.every((text) => text[text.length - 1 - suffix] === first[first.length - 1 - suffix])
  ) {
    suffix += 1;
  }

  return {
    prefix: prefix >= MIN_AFFIX ? prefix : 0,
    suffix: suffix >= MIN_AFFIX ? suffix : 0,
  };
}

/**
 * Trim off the shared parts. If too little is left after trimming, the full text
 * is returned instead: better to pay for extra tokens than send the model a scrap
 * of text and get a made-up salary range back.
 */
export function stripBoilerplate(text: string, affixes: Affixes): string {
  if (!affixes.prefix && !affixes.suffix) return text;

  const kept = text.length - affixes.prefix - affixes.suffix;
  if (kept < MIN_KEPT) return text;

  return text.slice(affixes.prefix, text.length - affixes.suffix).trim();
}

/**
 * Shared parts for a company, computed from already saved vacancies.
 * Cached within the process: a company comes up dozens of times during one run.
 */
const cache = new Map<number, Affixes>();

export async function affixesForCompany(companyId: number): Promise<Affixes> {
  const cached = cache.get(companyId);
  if (cached) return cached;

  const db = getDb();
  const rows = await db
    .select({ rawText: vacancies.rawText })
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNotNull(vacancies.rawText)))
    .limit(20);

  const affixes = commonAffixes(rows.map((row) => row.rawText ?? ''));
  cache.set(companyId, affixes);
  return affixes;
}

export function resetAffixCache(): void {
  cache.clear();
}
