import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain, normalizeUrl } from '../../lib/normalize.js';
import type { RawCompany } from '../registry.js';

const SOURCE = 'dou';
const BASE = 'https://jobs.dou.ua/companies/';

/**
 * DOU віддає по 20 компаній на сторінку, а "більше компаній" це POST з CSRF-токеном.
 * Замість того, щоб імітувати сесію, обходимо перелік комбінацій фільтрів: кожна дає
 * свою першу сторінку, і разом вони покривають каталог без жодного трюку.
 */
/**
 * За замовчуванням шукаємо сервісні компанії і аутстаф: саме там потрібен підрядник.
 * Продуктові гіганти лишаються доступними явним --business "Tech Product".
 */
export const BUSINESS_TYPES = ['Service', 'Outstaffing', 'Startup'];
export const ALL_BUSINESS_TYPES = [...BUSINESS_TYPES, 'Tech Product', 'R&D Center', 'Recruiting Agency'];
export const DOMAINS = [
  'AI / Machine Learning',
  'E-commerce / Marketplace',
  'Fintech',
  'Healthcare / MedTech',
  'Media / Entertainment',
  'SaaS',
];

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function listUrl(filters: { business?: string; domain?: string; name?: string } = {}): string {
  const url = new URL(BASE);
  if (filters.business) url.searchParams.set('business', filters.business);
  if (filters.domain) url.searchParams.set('domain', filters.domain);
  if (filters.name) url.searchParams.set('name', filters.name);
  return url.toString();
}

export interface DouListItem extends RawCompany {
  /** Сторінка компанії на DOU. Домен береться вже з неї. */
  profileUrl: string;
}

export function parseList(html: string, tags: string[] = []): DouListItem[] {
  const $ = cheerio.load(html);
  const items: DouListItem[] = [];

  $('li.l-company').each((_, node) => {
    const card = $(node);
    const link = card.find('a.cn-a').first();
    const name = clean(link.text());
    const profileUrl = link.attr('href');
    if (!name || !profileUrl) return;

    const vacancies = clean(card.find('.site a').first().text()).match(/(\d+)/);

    items.push({
      source: SOURCE,
      name,
      domain: null,
      country: 'UA',
      city: clean(card.find('.city').text()) || null,
      sizeHint: null,
      careersUrl: null,
      sourceUrl: normalizeUrl(profileUrl),
      tags,
      description: clean(card.find('.descr').text()) || null,
      openVacancies: vacancies ? Number(vacancies[1]) : null,
      profileUrl,
    });
  });

  return items;
}

const CAREERS_PATH = /(career|jobs|vacanc|join)/i;

/**
 * Домен, розмір і місто живуть на сторінці компанії, а не в картці переліку.
 * Розмір DOU пише кількома способами: "200...800 спеціалістів", "понад 1500 спеціалістів",
 * "51-200 співробітників". Один регексп на всі три, інакше поле буде порожнім у більшості.
 */
export function parseProfile(html: string): {
  domain: string | null;
  sizeHint: string | null;
  city: string | null;
  careersUrl: string | null;
} {
  const $ = cheerio.load(html);
  const head = $('.b-company-head, .company-info').first();
  const siteHref = head.find('.site a').first().attr('href') ?? $('.site a').first().attr('href');
  const text = clean(head.text());
  const size =
    /(понад\s*[\d\s]+|до\s*[\d\s]+|[\d\s]+\s*(?:\.{2,3}|[-\u2013\u2014])\s*[\d\s]+)\s*(?:спеціаліст|співробітник|людин)[\p{L}]*/iu.exec(
      text,
    );

  // DOU часто дає посилання одразу на сторінку вакансій компанії, це готовий careers_url.
  const careersUrl =
    siteHref && CAREERS_PATH.test(new URL(siteHref, 'https://example.com').pathname)
      ? normalizeUrl(siteHref.startsWith('http') ? siteHref : `https://${siteHref}`)
      : null;

  // В офісах перелічені всі міста разом із країнами, для картки досить першого.
  const offices = clean($('.offices').first().text());
  const city = offices.split(',')[0]?.replace(/\s*офіс$/i, '').trim() || null;

  return {
    domain: siteHref ? normalizeDomain(siteHref) : null,
    sizeHint: size ? clean(size[0]) : null,
    city,
    careersUrl,
  };
}

import type { CatalogSource } from '../registry.js';

export interface FetchCatalogOptions {
  business?: string[];
  domains?: string[];
  /** Скільки компаній максимум зібрати. Профілі тягнуться по одному на секунду. */
  limit?: number;
  /** Не ходити на сторінки компаній, лишити домен null. */
  skipProfiles?: boolean;
}

export async function fetchCatalog(options: FetchCatalogOptions = {}): Promise<RawCompany[]> {
  const businesses = options.business ?? BUSINESS_TYPES;
  const domains = options.domains ?? [undefined];
  const seen = new Map<string, DouListItem>();

  for (const business of businesses) {
    for (const domain of domains) {
      if (options.limit && seen.size >= options.limit) break;
      const url = listUrl({ business, domain });
      try {
        const res = await fetchText(url);
        const tags = [business, domain].filter((tag): tag is string => Boolean(tag));
        for (const item of parseList(res.body, tags)) {
          const existing = seen.get(item.profileUrl);
          if (existing) {
            existing.tags = [...new Set([...existing.tags, ...tags])];
          } else {
            seen.set(item.profileUrl, item);
          }
        }
      } catch (error) {
        log.warn({ url, err: String(error) }, 'не вдалось прочитати сторінку каталогу DOU');
      }
    }
  }

  const items = [...seen.values()].slice(0, options.limit ?? seen.size);
  if (options.skipProfiles) return items;

  for (const item of items) {
    try {
      const res = await fetchText(item.profileUrl);
      const profile = parseProfile(res.body);
      item.domain = profile.domain;
      item.sizeHint = profile.sizeHint;
      item.city = profile.city ?? item.city;
      item.careersUrl = profile.careersUrl;
    } catch (error) {
      log.warn({ url: item.profileUrl, err: String(error) }, 'не вдалось прочитати сторінку компанії DOU');
    }
  }

  return items;
}


export const dou: CatalogSource = {
  id: SOURCE,
  kind: 'catalog',
  parse: (payload: string) => parseList(payload),
  fetch: () => fetchCatalog({ limit: 40 }),
};
