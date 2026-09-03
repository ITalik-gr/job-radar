import { isoWeek, normalizeDomain, slugify } from '../lib/normalize.js';

/**
 * Одна вакансія буде на сайті компанії, на Djinni і на DOU одночасно.
 * Ключ навмисно грубий: домен, назва, тиждень першої появи. При збігу запис не
 * дублюється, а до наявного дописується джерело.
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
