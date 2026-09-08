import * as cheerio from 'cheerio';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, type Company } from '../db/schema.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { normalizeUrl } from '../lib/normalize.js';
import { withRun } from '../lib/runs.js';

/** Шляхи, які пробуються по черзі. Порядок за спаданням імовірності. */
export const CAREER_PATHS = [
  '/careers',
  '/career',
  '/jobs',
  '/vacancies',
  '/join-us',
  '/join',
  '/work-with-us',
  '/team/careers',
];

const CAREER_TEXT = /(career|job|vacanc|join us|hiring|ваканс|карʼєр|кар'єр|команда)/i;

/**
 * Ознаки стеку прямо з HTML. Дешева евристика, але робоча: сліди рушія лишаються
 * в атрибутах, іменах бандлів і адресах CDN, і підробити їх нема кому.
 */
export const TECH_MARKERS: [RegExp, string][] = [
  [/_next\/|__NEXT_DATA__/i, 'next.js'],
  [/__NUXT__|_nuxt\//i, 'nuxt'],
  [/wp-content|wp-includes/i, 'wordpress'],
  [/data-astro|astro-island/i, 'astro'],
  [/data-reactroot|react(-dom)?[.@]/i, 'react'],
  [/ng-version|angular/i, 'angular'],
  [/data-svelte|svelte-/i, 'svelte'],
  [/vue(\.runtime)?\.|data-v-app/i, 'vue'],
  [/shopify|cdn\.shopify/i, 'shopify'],
  [/webflow/i, 'webflow'],
  [/tilda|tildacdn/i, 'tilda'],
  [/gatsby/i, 'gatsby'],
  [/__remixContext|remix-run/i, 'remix'],
  [/__sveltekit|kit\.start\(/i, 'sveltekit'],
  [/cdn\.sanity\.io|sanity-io|apicdn\.sanity/i, 'sanity'],
  [/ctfassets\.net|contentful/i, 'contentful'],
  [/strapi/i, 'strapi'],
  [/a\.storyblok\.com|storyblok/i, 'storyblok'],
  [/prismic\.io|images\.prismic/i, 'prismic'],
  [/graphassets\.com|hygraph|graphcms/i, 'hygraph'],
  [/datocms-assets|datocms/i, 'datocms'],
  [/payloadcms|\/api\/payload/i, 'payload'],
  [/directus/i, 'directus'],
  [/ghost\.io|ghost-sdk|content-api\/ghost/i, 'ghost'],
  [/craftcms|cpresources\//i, 'craft cms'],
  [/wix\.com|wixstatic/i, 'wix'],
  [/squarespace/i, 'squarespace'],
  [/framerusercontent|framer\.com/i, 'framer'],
  [/drupal/i, 'drupal'],
  [/magento|mage\/cookies/i, 'magento'],
  [/woocommerce|wc-ajax/i, 'woocommerce'],
  [/hubspot|hs-scripts/i, 'hubspot'],
  [/vercel\.app|x-vercel/i, 'vercel'],
  [/netlify\.app|netlify\.com/i, 'netlify'],
  [/pages\.dev|cloudflareinsights/i, 'cloudflare'],
  [/tailwind|tw-\w+-/i, 'tailwind'],
  [/js\.stripe\.com|stripe\.com\/v3/i, 'stripe'],
  [/supabase\.co/i, 'supabase'],
  [/firebaseapp\.com|firebaseio/i, 'firebase'],
];

/**
 * Ознаки з видимого тексту, а не з розмітки.
 *
 * Це друга половина картини, і без неї вона брехлива. Студія розповідає на сторінці
 * послуг, що робить headless-магазини на Shopify і Sanity, а її власний сайт при
 * цьому стоїть на WordPress: розмітка покаже WordPress і нічого більше. Для листа
 * важливіше те, що вона *робить клієнтам*, а не на чому зроблена її візитівка.
 *
 * Тому і збігів тут вимагається слово цілком: "react" всередині "reactive" не рахується.
 */
export const TEXT_MARKERS: [RegExp, string][] = [
  [/\bheadless\b/i, 'headless cms'],
  [/\bjamstack\b/i, 'jamstack'],
  [/\bheadless commerce\b|\bcomposable commerce\b/i, 'headless commerce'],
  [/\bnext\.?js\b/i, 'next.js'],
  [/\bnuxt\b/i, 'nuxt'],
  [/\bastro\b/i, 'astro'],
  [/\breact\b/i, 'react'],
  [/\bvue(\.js)?\b/i, 'vue'],
  [/\bsvelte(kit)?\b/i, 'svelte'],
  [/\bangular\b/i, 'angular'],
  [/\btypescript\b/i, 'typescript'],
  [/\bnode(\.js)?\b/i, 'node'],
  [/\bnest(\.js)?\b/i, 'nestjs'],
  [/\bgraphql\b/i, 'graphql'],
  [/\bsanity\b/i, 'sanity'],
  [/\bcontentful\b/i, 'contentful'],
  [/\bstrapi\b/i, 'strapi'],
  [/\bstoryblok\b/i, 'storyblok'],
  [/\bprismic\b/i, 'prismic'],
  [/\bhygraph\b|\bgraphcms\b/i, 'hygraph'],
  [/\bdatocms\b/i, 'datocms'],
  [/\bpayload\s?cms\b/i, 'payload'],
  [/\bdirectus\b/i, 'directus'],
  [/\bshopify(\s?plus)?\b/i, 'shopify'],
  [/\bwebflow\b/i, 'webflow'],
  [/\bwordpress\b/i, 'wordpress'],
  [/\bwoocommerce\b/i, 'woocommerce'],
  [/\bmagento\b|\badobe commerce\b/i, 'magento'],
  [/\bstripe\b/i, 'stripe'],
  [/\bsupabase\b/i, 'supabase'],
  [/\bfirebase\b/i, 'firebase'],
  [/\bpostgre(s|sql)\b/i, 'postgresql'],
  [/\bcloudflare\b/i, 'cloudflare'],
  [/\bvercel\b/i, 'vercel'],
  [/\baws\b|\bamazon web services\b/i, 'aws'],
  [/\bopenai\b/i, 'openai'],
  [/\banthropic\b|\bclaude\b/i, 'anthropic'],
  [/\bllm\b|\bai integration/i, 'ai integration'],
  [/\brag\b|\bvector (search|database)\b/i, 'rag'],
];

/** ATS впізнається за посиланням: далі працюємо тільки через його API. */
export const ATS_PATTERNS: [RegExp, string][] = [
  [/boards\.greenhouse\.io\/([\w-]+)|job-boards\.greenhouse\.io\/([\w-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([\w-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([\w-]+)/i, 'ashby'],
  [/([\w-]+)\.workable\.com/i, 'workable'],
  [/([\w-]+)\.recruitee\.com/i, 'recruitee'],
  [/([\w-]+)\.jobs\.personio\.(de|com)/i, 'personio'],
];

export interface AtsMatch {
  kind: string;
  slug: string;
}

/** ATS, які ми вміємо читати через API. Такий kind не можна замінювати на html. */
export const KNOWN_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio'];

export function detectAts(html: string): AtsMatch | null {
  for (const [pattern, kind] of ATS_PATTERNS) {
    const match = pattern.exec(html);
    if (match) {
      const slug = match.slice(1).find(Boolean);
      if (slug) return { kind, slug };
    }
  }
  return null;
}

export function detectTech(html: string): string[] {
  return TECH_MARKERS.filter(([pattern]) => pattern.test(html)).map(([, name]) => name);
}

/**
 * Те, про що компанія пише словами. Розбирається саме видимий текст: у розмітці
 * назви технологій трапляються у складі класів і бандлів, і збіг там нічого не
 * означає, а в тексті сторінки послуг означає рівно те, що написано.
 */
export function detectTechFromText(html: string): string[] {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ');

  return TEXT_MARKERS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** Обидві половини разом, без повторів: розмітка сайту плюс те, що написано словами. */
export function detectStack(html: string): string[] {
  return [...new Set([...detectTech(html), ...detectTechFromText(html)])];
}

/** Посилання на вакансії з хедера і футера: часто вони не на очевидному шляху. */
export function findCareerLinks(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();

  $('a[href]').each((_, node) => {
    const href = ($(node).attr('href') ?? '').trim();
    const text = $(node).text();
    // Порожній href резолвиться в головну сторінку, а текст посилання може бути "Careers".
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (!CAREER_TEXT.test(href) && !CAREER_TEXT.test(text)) return;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      found.add(normalizeUrl(url.href) ?? url.href);
    } catch {
      // Порожній або сміттєвий href, просто пропускаємо.
    }
  });

  return [...found];
}

/** Сторінка вакансій має містити щось схоже на перелік позицій, а не просто слово careers. */
export function looksLikeCareersPage(html: string): boolean {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $('body').text().toLowerCase();
  if (/(no open positions|немає відкритих ваканс|no current openings)/.test(text)) return true;

  const jobLinks = $('a[href]').filter((_, node) => {
    const href = $(node).attr('href') ?? '';
    return /(job|vacanc|position|opening|career)/i.test(href);
  }).length;

  return jobLinks >= 2 || /(open positions|current openings|відкриті ваканс|приєднуйся)/.test(text);
}

export interface DiscoveryResult {
  companyId: number;
  domain: string;
  careersUrl: string | null;
  careersKind: string;
  careersSlug: string | null;
  techHints: string[];
  attempts: number;
}

/**
 * Один прохід по компанії: головна сторінка дає стек і посилання на вакансії,
 * далі перевіряються типові шляхи. Якщо знайшовся ATS, HTML більше не чіпаємо.
 */
export async function discoverCompany(company: Company): Promise<DiscoveryResult> {
  const base = `https://${company.domain}`;
  const result: DiscoveryResult = {
    companyId: company.id,
    domain: company.domain,
    careersUrl: company.careersUrl,
    careersKind: company.careersKind,
    careersSlug: company.careersSlug,
    techHints: company.techHints,
    attempts: 0,
  };

  let homepage = '';
  try {
    const res = await fetchText(base);
    homepage = res.body;
    result.attempts += 1;
    result.techHints = [...new Set([...company.techHints, ...detectStack(homepage)])];
  } catch (error) {
    log.warn({ domain: company.domain, err: String(error) }, 'головна сторінка не відкрилась');
    return result;
  }

  // Відомий ATS зі slug це найцінніше, що є в картці компанії. Discovery може його
  // доповнити, але ніколи не понижує до html лише тому, що на головній немає посилання.
  const locked = KNOWN_ATS.includes(company.careersKind) && Boolean(company.careersSlug);

  const ats = detectAts(homepage);
  if (ats) {
    result.careersKind = ats.kind;
    result.careersSlug = ats.slug;
    result.careersUrl = result.careersUrl ?? base;
    return result;
  }

  const candidates = [
    ...findCareerLinks(homepage, base),
    ...CAREER_PATHS.map((path) => `${base}${path}`),
  ].filter((url) => new URL(url).hostname.endsWith(company.domain) || !url.startsWith(base));

  for (const url of candidates.slice(0, 10)) {
    try {
      const res = await fetchText(url);
      result.attempts += 1;

      const pageAts = detectAts(res.body);
      if (pageAts) {
        result.careersKind = pageAts.kind;
        result.careersSlug = pageAts.slug;
        result.careersUrl = url;
        return result;
      }

      if (looksLikeCareersPage(res.body)) {
        result.careersUrl = url;
        if (!locked) result.careersKind = 'html';
        return result;
      }
    } catch {
      // 404 на вгаданому шляху це нормальний результат, просто пробуємо наступний.
    }
  }

  if (!result.careersUrl && !locked) result.careersKind = 'none';
  return result;
}

export interface DiscoverOptions {
  limit?: number;
  /** Обійти конкретну компанію за доменом. */
  domain?: string;
  /** Ігнорувати обмеження і брати всіх підряд. */
  all?: boolean;
}

/**
 * Кого обходимо. Обмеження навмисне: компаній із каталогів будуть сотні, і сліпий
 * обхід усіх це тисяча марних запитів на добу. Беремо тільки цікаві або ті, чий сайт
 * уже показав фронтендовий стек.
 */
export async function candidatesForDiscovery(options: DiscoverOptions = {}): Promise<Company[]> {
  const db = getDb();
  if (options.domain) {
    return db.select().from(companies).where(eq(companies.domain, options.domain));
  }

  const rows = await db
    .select({ company: companies, status: companyState.status })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      and(
        or(eq(companies.careersKind, 'unknown'), isNull(companies.careersUrl)),
        sql`${companies.careersKind} != 'none'`,
        // Компанію з відомим ATS і slug обходити нема сенсу, її вакансії беруться з API.
        isNull(companies.careersSlug),
      ),
    );

  const interesting = rows.filter((row) => {
    if (options.all) return true;
    if (row.status === 'interesting') return true;
    return row.company.techHints.some((hint) => ['react', 'next.js', 'astro', 'vue', 'svelte', 'nuxt'].includes(hint));
  });

  // Компанії без жодного tech_hint ще не обходились, їм потрібен перший дотик до головної.
  const untouched = rows.filter((row) => row.company.techHints.length === 0);
  const pool = options.all ? rows : [...interesting, ...untouched];

  const unique = new Map(pool.map((row) => [row.company.id, row.company]));

  /*
   * Спершу ті, кого не чіпали найдовше, і `null` попереду всіх. Це не косметика:
   * компанія, чия головна не відкрилась, лишається в тому самому наборі кандидатів,
   * і без цього порядку кожна наступна партія бралась би за ту саму десятку.
   */
  const ordered = [...unique.values()].sort((a, b) => (a.lastChecked ?? 0) - (b.lastChecked ?? 0));
  return ordered.slice(0, options.limit ?? 25);
}

/** Скільки компаній чекає на обхід. Потрібне інтерфейсу, щоб знати, коли зупинитись. */
export async function pendingDiscovery(options: DiscoverOptions = {}): Promise<number> {
  const all = await candidatesForDiscovery({ ...options, limit: Number.MAX_SAFE_INTEGER });
  return all.length;
}

export interface DiscoverStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  checked: number;
  withAts: number;
  withHtml: number;
  none: number;
  /** Скільки компаній лишилось після цієї партії. Нуль означає, що обхід закінчено. */
  remaining: number;
}

export async function discover(options: DiscoverOptions = {}): Promise<DiscoverStats> {
  return withRun('discover', async () => {
    const db = getDb();
    const pending = await pendingDiscovery(options);
    const targets = await candidatesForDiscovery(options);
    const stats: DiscoverStats = {
      itemsFound: targets.length,
      itemsNew: 0,
      errors: [],
      checked: 0,
      withAts: 0,
      withHtml: 0,
      none: 0,
      remaining: Math.max(0, pending - targets.length),
    };

    for (const company of targets) {
      try {
        const result = await discoverCompany(company);
        stats.checked += 1;

        if (result.careersSlug) stats.withAts += 1;
        else if (result.careersKind === 'html') stats.withHtml += 1;
        else if (result.careersKind === 'none') stats.none += 1;

        if (result.careersUrl && !company.careersUrl) stats.itemsNew += 1;

        await db
          .update(companies)
          .set({
            careersUrl: result.careersUrl,
            careersKind: result.careersKind,
            careersSlug: result.careersSlug,
            techHints: result.techHints,
            lastChecked: Date.now(),
          })
          .where(eq(companies.id, company.id));
      } catch (error) {
        const message = `${company.domain}: ${error instanceof Error ? error.message : String(error)}`;
        stats.errors.push(message);
        log.warn({ err: message }, 'discovery впав на компанії');
        // Позначка часу навіть на невдачі: інакше ця компанія вічно перша в черзі.
        await db.update(companies).set({ lastChecked: Date.now() }).where(eq(companies.id, company.id));
      }
    }

    return stats;
  });
}
