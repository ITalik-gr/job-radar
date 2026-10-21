/** Normalizing domains and strings. Page text normalization comes in Stage 3. */

export const TRACKING_PARAMS =
  /^(utm_|ref$|referrer$|gh_src$|source$|fbclid$|gclid$|mc_cid$|mc_eid$|lever-source$|lever-origin$|trk$)/i;

export function normalizeDomain(input: string): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!value.includes('://')) value = `https://${value}`;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (!host.includes('.')) return null;
  return host;
}

export function normalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'e',
};

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[Ѐ-ӿ]/g, (char) => TRANSLIT[char] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function collapseWhitespace(input: string): string {
  return input.replace(/[\t\f\r ]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/** ISO week in the format 2026-W07, a component of the dedupe key. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Country names as catalogs write them, mapped to ISO 3166 alpha-2. Keys are lower case.
 * Migration 0019 applied the same map to the rows already stored, keep the two in step.
 */
export const COUNTRY_CODES: Record<string, string> = {
  usa: 'US', 'united states': 'US', 'united states of america': 'US', us: 'US',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', gb: 'GB',
  ukraine: 'UA', україна: 'UA', украина: 'UA', ua: 'UA',
  india: 'IN', canada: 'CA', germany: 'DE', poland: 'PL', france: 'FR', singapore: 'SG',
  mexico: 'MX', 'united arab emirates': 'AE', uae: 'AE', sweden: 'SE', switzerland: 'CH',
  brazil: 'BR', australia: 'AU', vietnam: 'VN', spain: 'ES', israel: 'IL', denmark: 'DK',
  colombia: 'CO', norway: 'NO', nigeria: 'NG', netherlands: 'NL', 'the netherlands': 'NL',
  malaysia: 'MY', indonesia: 'ID', 'hong kong': 'HK', belgium: 'BE', uruguay: 'UY',
  tanzania: 'TZ', 'south korea': 'KR', 'south africa': 'ZA', 'saudi arabia': 'SA',
  romania: 'RO', portugal: 'PT', lithuania: 'LT', jordan: 'JO', estonia: 'EE', latvia: 'LV',
  cyprus: 'CY', bulgaria: 'BG', italy: 'IT', ireland: 'IE', austria: 'AT', finland: 'FI',
  'czech republic': 'CZ', czechia: 'CZ', slovenia: 'SI', slovakia: 'SK', hungary: 'HU',
  moldova: 'MD', armenia: 'AM', japan: 'JP', china: 'CN', turkey: 'TR',
  türkiye: 'TR', argentina: 'AR', chile: 'CL', 'new zealand': 'NZ', pakistan: 'PK',
  philippines: 'PH', egypt: 'EG', kenya: 'KE', serbia: 'RS', croatia: 'HR', greece: 'GR',
};

/**
 * A country as an ISO alpha-2 code. "Remote" and the like are not a country and become null.
 * An unknown name is kept as written: losing it would be worse than an unmerged facet value.
 */
export function normalizeCountry(input: string | null | undefined): string | null {
  const value = (input ?? '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (['remote', 'worldwide', 'global', 'anywhere'].includes(lower)) return null;
  if (COUNTRY_CODES[lower]) return COUNTRY_CODES[lower];
  if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase();
  return value;
}
