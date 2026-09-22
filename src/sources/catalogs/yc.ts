import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import type { CatalogSource, RawCompany } from '../registry.js';

/**
 * The Y Combinator company catalog, CLAUDE.md section 4, priority 2.
 *
 * The `hiring` slice is taken, not all 6200 companies: it holds only those
 * currently hiring, weighs four times less, and doesn't clutter the database with
 * burned-out decade-old startups. The source is static, public and needs no keys,
 * so hitting it is cheap and honest.
 *
 * From there the usual chain runs: discovery finds the company's careers page,
 * recognizes the ATS and pulls vacancies through the API. So YC doesn't give vacancies, it gives entry points.
 */

const SOURCE = 'yc';
const HIRING_URL = 'https://yc-oss.github.io/api/companies/hiring.json';

export interface YcCompany {
  name: string;
  website?: string | null;
  all_locations?: string | null;
  one_liner?: string | null;
  long_description?: string | null;
  team_size?: number | null;
  industry?: string | null;
  subindustry?: string | null;
  tags?: string[];
  batch?: string | null;
  status?: string | null;
  url?: string | null;
  isHiring?: boolean;
}

/**
 * Size by team headcount, not by a catalog range: at YC it's a number, and it needs
 * to be reduced to the same buckets as Clutch for size scoring.
 */
export function sizeBucket(teamSize: number | null | undefined): string | null {
  if (!teamSize || teamSize < 1) return null;
  if (teamSize < 10) return '1 - 9';
  if (teamSize < 50) return '10 - 49';
  if (teamSize < 250) return '50 - 249';
  if (teamSize < 1000) return '250 - 999';
  return '1,000 - 9,999';
}

/**
 * The location arrives as a string "San Francisco, CA, USA; Remote". We take the
 * first entry: that's the main office, the rest is branches and the word Remote.
 */
export function splitLocation(value: string | null | undefined): {
  city: string | null;
  country: string | null;
} {
  const first = (value ?? '').split(';')[0]?.trim();
  if (!first) return { city: null, country: null };

  const parts = first.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, country: null };
  if (parts.length === 1) return { city: null, country: parts[0]! };
  return { city: parts[0]!, country: parts[parts.length - 1]! };
}

export function parseYc(payload: string): RawCompany[] {
  let list: YcCompany[];
  try {
    list = JSON.parse(payload) as YcCompany[];
  } catch (error) {
    throw new Error(`YC: response is not JSON, ${String(error).slice(0, 120)}`);
  }
  if (!Array.isArray(list)) throw new Error('YC: expected an array of companies');

  const companies: RawCompany[] = [];
  for (const item of list) {
    const domain = normalizeDomain(item.website ?? '');
    // A company with no site is useless: there's nowhere to go for a careers page or contacts.
    if (!item.name || !domain) continue;
    if (item.status && item.status.toLowerCase() === 'inactive') continue;

    const { city, country } = splitLocation(item.all_locations);

    companies.push({
      source: SOURCE,
      name: item.name,
      domain,
      country,
      city,
      sizeHint: sizeBucket(item.team_size),
      careersUrl: null,
      sourceUrl: item.url ?? null,
      /*
       * Industry and tags deliberately land in the same tags list: company scoring
       * reads exactly those, and that's what shows whether it's a web product or a robot factory.
       */
      tags: [item.industry, item.subindustry?.split('->').pop(), ...(item.tags ?? [])]
        .map((tag) => tag?.trim())
        .filter((tag): tag is string => Boolean(tag)),
      description: item.one_liner ?? item.long_description ?? null,
      openVacancies: null,
      extra: {
        ...(item.batch ? { Batch: item.batch } : {}),
        ...(item.team_size ? { 'Team size': String(item.team_size) } : {}),
      },
    });
  }

  log.debug({ found: companies.length }, 'YC parsed');
  return companies;
}

export const yc: CatalogSource = {
  id: SOURCE,
  kind: 'catalog',
  async fetch() {
    const response = await fetchText(HIRING_URL);
    return parseYc(response.body);
  },
  parse(payload: string) {
    return parseYc(payload);
  },
};
