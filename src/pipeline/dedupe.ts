import { isoWeek, normalizeDomain, slugify } from '../lib/normalize.js';

/**
 * The same vacancy can be on the company's site, on Djinni and on DOU at the same time.
 * The key is deliberately coarse: domain, title, the week it first appeared. On a match
 * the record is not duplicated, the source is appended to the existing one instead.
 */
export function dedupeKey(input: {
  domain: string | null;
  title: string | null;
  url: string;
  firstSeen?: Date | number;
}): string {
  const domain = input.domain ? normalizeDomain(input.domain) : null;
  const host = domain ?? normalizeDomain(input.url) ?? 'unknown';
  const title = slugify(input.title ?? '') || slugify(new URL(input.url).pathname) || 'untitled';
  const week = isoWeek(
    input.firstSeen instanceof Date ? input.firstSeen : new Date(input.firstSeen ?? Date.now()),
  );
  return `${host}|${title}|${week}`;
}

/**
 * The key without the week: host and title. Lookups and closing go by this part only.
 *
 * With the week in the lookup, every Monday the same open vacancy stopped matching its own
 * row: it was inserted again as new and the old row was closed as missing, so no vacancy
 * could live longer than seven days and the lifetime stats measured nothing. The week stays
 * in the stored key, so a title re-posted long after the old one closed is a new record.
 */
export function dedupeStem(key: string): string {
  return key.slice(0, key.lastIndexOf('|'));
}

/** A vacancy seen within this window is the same one; later it counts as a re-post. */
export const REPOST_AFTER_MS = 30 * 86_400_000;

export function mergeSources(existing: string, incoming: string): string {
  const set = new Set(existing.split(',').filter(Boolean));
  set.add(incoming);
  return [...set].join(',');
}
