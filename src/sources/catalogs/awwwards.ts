import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import type { CatalogSource, RawCompany } from '../registry.js';

/**
 * Awwwards as a design studio catalog.
 *
 * Why: this is exactly the niche the owner talked about, studios with a living
 * front end, where you write not about a vacancy but with an offer to help. Item 5
 * in "Next, by priority" in STATUS.md.
 *
 * robots.txt allows `/directory/`, search and `/websites/?` are disallowed. So we
 * only go to the catalog and to studio profiles, we don't use search.
 *
 * A studio's domain sits at the third level: the catalog gives a link to the
 * profile, and only the profile has the real site. So it's one request per studio, same as with Getro.
 */

const BASE = 'https://www.awwwards.com';

/**
 * The site's utility sections. The catalog and navigation both use links shaped
 * like `/something/`, and without this list "Cookie Policy" and "Academy" would end
 * up counted as companies.
 */
const NOT_A_PROFILE = new Set([
  'about-us',
  'academy',
  'annual-awards',
  'blog',
  'collections',
  'contact-us',
  'cookies-policy',
  'directory',
  'elements',
  'faqs',
  'jobs',
  'market',
  'privacy-policy',
  'terms',
  'websites',
  'winner-list',
  'inspiration',
  'nominees',
  'submit',
  'pricing',
  'sign-up',
  'login',
]);

/** Social networks and services. A studio's site is not one of these. */
const NOT_A_SITE =
  /(facebook|twitter|x\.com|linkedin|instagram|youtube|vimeo|behance|dribbble|github|medium|tiktok|pinterest|awwwards|google|gstatic|cloudflare|typekit|fontawesome)/i;

export function parseDirectory(html: string): string[] {
  const body = html.slice(Math.max(0, html.indexOf('<body')));
  const slugs = new Set<string>();

  for (const match of body.matchAll(/href="\/([a-z0-9][a-z0-9-]{2,40})\/"/gi)) {
    const slug = match[1]!.toLowerCase();
    if (NOT_A_PROFILE.has(slug)) continue;
    slugs.add(slug);
  }

  return [...slugs];
}

/**
 * Compound top-level domains. Without this list `resn.co.nz` collapsed to `co.nz`,
 * and the database ended up with a company whose "domain" was a suffix instead of a real site.
 */
const MULTI_TLD = new Set([
  'co.uk', 'co.nz', 'co.za', 'co.jp', 'co.kr', 'co.in', 'co.il',
  'com.au', 'com.br', 'com.ua', 'com.tr', 'com.mx', 'com.sg', 'com.hk',
  'org.uk', 'net.au', 'net.nz', 'ac.uk', 'gov.uk',
]);

/** Reduces a domain to its root, accounting for compound top-level domains. */
function registrable(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_TLD.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** For comparing against the studio's name: letters and digits only. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A studio's site from its profile.
 *
 * A domain resembling the studio's name or slug is searched for first. Only if
 * there's none is the most frequent one taken. The reason: a profile also lists work
 * done for clients, and for a studio with one big client, that client's domain shows
 * up more often than the studio's own. On live data Immersive Garden got cartier.com,
 * and AQuest got gucci.com.
 */
export function parseProfile(html: string, slug: string): RawCompany | null {
  const body = html.slice(Math.max(0, html.indexOf('<body')));

  const name = /<h1[^>]*>([\s\S]{0,120}?)<\/h1>/i
    .exec(body)?.[1]
    ?.replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;

  const counts = new Map<string, number>();
  for (const match of body.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
    const url = match[1]!;
    if (NOT_A_SITE.test(url)) continue;
    const domain = normalizeDomain(url);
    if (!domain) continue;
    // Subdomains are reduced to their root: obys.agency and library.obys.agency are the same site.
    const root = registrable(domain);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }

  const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const needles = [squash(name), squash(slug)].filter((value) => value.length >= 4);

  const byName = candidates.find(([root]) => {
    const label = squash(root.split('.')[0]!);
    return needles.some((needle) => label.includes(needle) || needle.includes(label));
  });

  const domain = (byName ?? candidates[0])?.[0] ?? null;
  if (!domain) return null;

  return {
    source: 'awwwards',
    name,
    domain,
    country: null,
    city: null,
    sizeHint: null,
    careersUrl: null,
    sourceUrl: `${BASE}/${slug}/`,
    // We set the tag ourselves: the profile has no category listing, but simply
    // being present in the Awwwards catalog already means a studio with a strong front end.
    tags: ['Web Design', 'UI/UX Design'],
    description: null,
    openVacancies: null,
  };
}

export const awwwards: CatalogSource = {
  id: 'awwwards',
  kind: 'catalog',

  parse(payload: string): RawCompany[] {
    // For the smoke test we accept a profile page: that's exactly what produces a company.
    const company = parseProfile(payload, 'fixture');
    return company ? [company] : [];
  },

  async fetch(): Promise<RawCompany[]> {
    const res = await fetchText(`${BASE}/directory/`);
    const slugs = parseDirectory(res.body);
    const companies: RawCompany[] = [];

    for (const slug of slugs) {
      try {
        const profile = await fetchText(`${BASE}/${slug}/`);
        const company = parseProfile(profile.body, slug);
        if (company) companies.push(company);
      } catch {
        // The slug could have turned out to be a utility page, or the profile was taken down.
      }
    }

    log.info({ slugs: slugs.length, companies: companies.length }, 'awwwards: catalog collected');
    return companies;
  },
};
