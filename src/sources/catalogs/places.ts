import { config } from '../../config.js';
import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { rotate } from '../../lib/rotate.js';
import { readSetting, writeSetting } from '../../lib/settings-store.js';
import { localDay } from '../../lib/time.js';
import placesConfig from '../../../config/places.json' with { type: 'json' };
import type { CatalogSource, RawCompany, SourceContext } from '../registry.js';

/**
 * Google Places API (New), section 4 of CLAUDE.md: Ukrainian businesses by niche and city, with
 * their site and phone. A dental clinic in Lviv with a slow site, or with no site at all, is the
 * radar's main SMB lead.
 *
 * Text Search with website and phone in the field mask is billed as the Enterprise SKU, which has
 * a monthly free usage. Two guards keep a run inside it: a few queries per run, rotated through
 * every niche and city, and a monthly call counter that stops the source before the cap.
 */

const SOURCE = 'places';
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.websiteUri',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
].join(',');

const CURSOR_KEY = 'places_cursor';
const USAGE_KEY = 'places_usage';

/**
 * A profile on these hosts is not the business's own site. Taken as a domain it would merge every
 * clinic with an Instagram page into one company called instagram.com.
 */
const NOT_A_SITE = /(^|\.)(facebook\.com|instagram\.com|t\.me|telegram\.me|linktr\.ee|tiktok\.com|youtube\.com|google\.com|goo\.gl|business\.site|viber\.com|wa\.me|linkedin\.com|x\.com|twitter\.com)$/i;

interface Place {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  websiteUri?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  googleMapsUri?: string;
}

export interface PlacesQuery {
  industry: string;
  query: string;
  city: string;
}

/** Every niche in every city, in a fixed order the cursor walks through. */
export function allQueries(): PlacesQuery[] {
  return placesConfig.cities.flatMap((city) =>
    placesConfig.niches.map((niche) => ({ industry: niche.industry, query: niche.query, city })),
  );
}

/** The business's own site, or null for a social profile or a missing link. */
export function siteDomain(uri: string | null | undefined): string | null {
  const domain = normalizeDomain(uri ?? '');
  if (!domain || NOT_A_SITE.test(domain)) return null;
  return domain;
}

function component(place: Place, type: string): { longText?: string; shortText?: string } | undefined {
  return place.addressComponents?.find((part) => part.types?.includes(type));
}

/** One Text Search response. `ctx.slug` carries the industry of the query that produced it. */
export function parsePlaces(payload: string, ctx: SourceContext = {}): RawCompany[] {
  let response: { places?: Place[]; error?: { message?: string } };
  try {
    response = JSON.parse(payload) as typeof response;
  } catch (error) {
    throw new Error(`Places: response is not JSON, ${String(error).slice(0, 120)}`);
  }
  if (response.error) throw new Error(`Places: ${response.error.message ?? 'error response'}`);

  const companies: RawCompany[] = [];
  for (const place of response.places ?? []) {
    const name = place.displayName?.text?.trim();
    if (!place.id || !name) continue;
    // A closed business is not a lead, however good its old site looks.
    if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') continue;

    const domain = siteDomain(place.websiteUri);
    companies.push({
      source: SOURCE,
      name,
      domain,
      placeId: place.id,
      country: component(place, 'country')?.shortText ?? null,
      city: component(place, 'locality')?.longText ?? null,
      address: place.formattedAddress ?? null,
      phone: place.internationalPhoneNumber?.replace(/[\s()-]/g, '') ?? null,
      industry: ctx.slug ?? null,
      kind: 'smb',
      sizeHint: null,
      careersUrl: null,
      sourceUrl: place.googleMapsUri ?? null,
      tags: [],
      description: null,
      openVacancies: null,
      rating: place.rating ?? null,
      reviewsCount: place.userRatingCount ?? null,
      // A social profile is still a way to reach the business, it just is not a site.
      extra: !domain && place.websiteUri ? { Profile: place.websiteUri } : {},
    });
  }
  return companies;
}

interface Usage {
  month: string;
  calls: number;
}

async function search(query: PlacesQuery): Promise<RawCompany[]> {
  const response = await fetchText(SEARCH_URL, {
    method: 'POST',
    // A keyed API used within its terms, not a site to crawl.
    ignoreRobots: true,
    retries: 1,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.places.apiKey,
      'x-goog-fieldmask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: `${query.query} ${query.city}`,
      languageCode: 'uk',
      regionCode: 'UA',
      pageSize: 20,
    }),
  });
  return parsePlaces(response.body, { slug: query.industry });
}

export const places: CatalogSource = {
  id: SOURCE,
  kind: 'catalog',
  async fetch() {
    if (!config.places.apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set, the Places source is off');

    const month = localDay().slice(0, 7);
    const stored = await readSetting<Usage | null>(USAGE_KEY, null);
    const usage: Usage = stored?.month === month ? stored : { month, calls: 0 };
    const budget = Math.min(config.places.queriesPerRun, config.places.monthlyLimit - usage.calls);
    if (budget <= 0) throw new Error(`Places monthly limit reached: ${usage.calls} of ${config.places.monthlyLimit} calls`);

    const queries = allQueries();
    const cursor = await readSetting<number>(CURSOR_KEY, 0);
    const batch = rotate(queries, cursor).slice(0, budget);

    const found: RawCompany[] = [];
    const failures: string[] = [];
    for (const query of batch) {
      // Counted before the call: Google bills a request that failed on our side too.
      usage.calls += 1;
      try {
        found.push(...(await search(query)));
      } catch (error) {
        failures.push(`${query.query} ${query.city}: ${error instanceof Error ? error.message : String(error)}`);
        log.warn({ query, err: String(error) }, 'Places query failed');
      }
    }
    await writeSetting(USAGE_KEY, usage);
    await writeSetting(CURSOR_KEY, (cursor + batch.length) % queries.length);
    // One failed query is a warning in the log; all of them failing is a broken source.
    if (failures.length === batch.length) throw new Error(failures[0]);

    log.info({ queries: batch.length, found: found.length, monthCalls: usage.calls }, 'Places run done');
    return found;
  },
  parse(payload: string, ctx?: SourceContext) {
    return parsePlaces(payload, ctx);
  },
};
