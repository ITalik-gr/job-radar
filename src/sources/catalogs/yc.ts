import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import type { CatalogSource, RawCompany } from '../registry.js';

/**
 * Каталог компаній Y Combinator, CLAUDE.md розділ 4, пріоритет 2.
 *
 * Береться зріз `hiring`, а не всі 6200 компаній: він містить лише тих, хто
 * зараз наймає, важить у чотири рази менше і не засмічує базу вигорілими
 * стартапами десятирічної давності. Джерело статичне, публічне і без ключів,
 * тому ходити до нього дешево і чесно.
 *
 * Далі працює звичайний ланцюжок: discovery знаходить career-сторінку компанії,
 * впізнає ATS і забирає вакансії через API. Тобто YC дає не вакансії, а входи.
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
 * Розмір командою, а не діапазоном з каталогу: у YC це число, і зводити його до
 * тих самих кошиків, що й у Clutch, потрібно для скорингу розміру.
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
 * Локація приходить рядком "San Francisco, CA, USA; Remote". Беремо перший
 * запис: він і є основним офісом, решта це філії і слово Remote.
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
    throw new Error(`YC: відповідь не є JSON, ${String(error).slice(0, 120)}`);
  }
  if (!Array.isArray(list)) throw new Error('YC: очікувався масив компаній');

  const companies: RawCompany[] = [];
  for (const item of list) {
    const domain = normalizeDomain(item.website ?? '');
    // Компанія без сайту марна: нема куди йти по career-сторінку і по контакти.
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
       * Індустрія і теги лягають в одні теги навмисно: скоринг компаній читає
       * саме їх, і саме за ними видно, чи це веб-продукт, чи завод роботів.
       */
      tags: [item.industry, item.subindustry?.split('->').pop(), ...(item.tags ?? [])]
        .map((tag) => tag?.trim())
        .filter((tag): tag is string => Boolean(tag)),
      description: item.one_liner ?? item.long_description ?? null,
      openVacancies: null,
      extra: {
        ...(item.batch ? { Батч: item.batch } : {}),
        ...(item.team_size ? { Команда: String(item.team_size) } : {}),
      },
    });
  }

  log.debug({ found: companies.length }, 'YC розібрано');
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
