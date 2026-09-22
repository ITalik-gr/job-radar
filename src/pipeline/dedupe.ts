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

export function mergeSources(existing: string, incoming: string): string {
  const set = new Set(existing.split(',').filter(Boolean));
  set.add(incoming);
  return [...set].join(',');
}
