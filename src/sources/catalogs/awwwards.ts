import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import type { CatalogSource, RawCompany } from '../registry.js';

/**
 * Awwwards як каталог дизайн-студій.
 *
 * Навіщо: це саме та ніша, про яку казав власник, студії з живим фронтендом,
 * куди пишуть не на вакансію, а з пропозицією допомогти. Пункт 5 у "Далі,
 * за пріоритетом" у STATUS.md.
 *
 * robots.txt дозволяє `/directory/`, заборонені пошук і `/websites/?`. Тому
 * ходимо тільки на каталог і на профілі студій, пошуком не користуємось.
 *
 * Домен студії лежить на третьому рівні: каталог дає посилання на профіль,
 * і лише в профілі є справжній сайт. Тому один запит на студію, як і в Getro.
 */

const BASE = 'https://www.awwwards.com';

/**
 * Службові розділи сайту. Каталог і навігація віддаються однаковими посиланнями
 * виду `/щось/`, і без цього переліку в компанії потрапили б "Політика cookie"
 * і "Академія".
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

/** Соцмережі і сервіси. Сайт студії це не вони. */
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
 * Складені домени верхнього рівня. Без цього переліку `resn.co.nz` зводився до
 * `co.nz`, і в базі зʼявлялась компанія з доменом суфікса замість сайта.
 */
const MULTI_TLD = new Set([
  'co.uk', 'co.nz', 'co.za', 'co.jp', 'co.kr', 'co.in', 'co.il',
  'com.au', 'com.br', 'com.ua', 'com.tr', 'com.mx', 'com.sg', 'com.hk',
  'org.uk', 'net.au', 'net.nz', 'ac.uk', 'gov.uk',
]);

/** Звести домен до кореня з урахуванням складених доменів. */
function registrable(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_TLD.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Для порівняння з назвою студії: тільки літери і цифри. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Сайт студії з її профілю.
 *
 * Спершу шукається домен, схожий на назву або slug студії. Тільки якщо такого
 * немає, береться найчастіший. Причина: у профілі поруч лежать роботи для клієнтів,
 * і в студії з одним великим клієнтом його домен трапляється частіше за власний.
 * На живих даних Immersive Garden отримав cartier.com, а AQuest gucci.com.
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
    // Піддомени зводяться до кореня: obys.agency і library.obys.agency це один сайт.
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
    // Тег ставимо самі: у профілі немає рубрикатора, але сам факт присутності
    // в каталозі Awwwards означає студію з сильним фронтендом.
    tags: ['Web Design', 'UI/UX Design'],
    description: null,
    openVacancies: null,
  };
}

export const awwwards: CatalogSource = {
  id: 'awwwards',
  kind: 'catalog',

  parse(payload: string): RawCompany[] {
    // Для smoke-тесту приймаємо сторінку профілю: саме вона дає компанію.
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
        // Слуг міг виявитись службовою сторінкою або профіль закритий.
      }
    }

    log.info({ slugs: slugs.length, companies: companies.length }, 'awwwards: каталог зібрано');
    return companies;
  },
};
