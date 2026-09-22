import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * DOU as a vacancy board, not as a company catalog. The shortest path to the
 * Ukrainian market, and most importantly to salary ranges: ATS sources almost never show them.
 *
 * robots.txt allows `/vacancies/`, the disallows there only concern Yandex and
 * internal ajax paths. The page is served by the server, so no browser is needed.
 */

/** DOU categories. In config, so a new one can be added without touching code. */
export const DOU_CATEGORIES = ['Front End', 'Node.js', 'Fullstack'];

const COMPANY_URL = /jobs\.dou\.ua\/companies\/([a-z0-9._-]+)\//i;

export interface DouVacancy extends RawVacancy {
  /** The company's slug on DOU. Needed to attach the domain with a separate request. */
  companySlug: string | null;
}

export function parseDou(html: string): DouVacancy[] {
  const $ = cheerio.load(html);
  const rows: DouVacancy[] = [];

  $('li.l-vacancy').each((_, element) => {
    const card = $(element);
    const link = card.find('a.vt').first();
    const url = link.attr('href');
    const title = link.text().trim();
    if (!url || !title) return;

    // The company name sits in the same node as the favicon, so only the text is taken.
    const companyName = card.find('a.company').first().text().trim() || null;
    const companySlug = COMPANY_URL.exec(card.find('a.company').first().attr('href') ?? '')?.[1] ?? null;
    const location = card.find('.cities').text().trim() || null;
    const salary = card.find('.salary').text().trim() || null;
    const description = card.find('.sh-info').text().trim();

    const externalId = /\/vacancies\/(\d+)/.exec(url)?.[1] ?? null;

    rows.push({
      source: 'dou:vacancies',
      externalId,
      url,
      title,
      // The salary range goes into the text: scoring and the model read exactly that, there's no separate field here.
      rawText: [title, salary, location, description].filter(Boolean).join('\n'),
      companyName,
      companyDomain: null,
      location,
      // "віддалено" is Ukrainian for "remote", the sign of remote work.
      remote: location ? /віддален|remote/i.test(location) : null,
      postedAt: null,
      companySlug,
    });
  });

  return rows;
}

/**
 * The company domain isn't shown on the listing page, and without it a vacancy can't
 * be linked to a company card or merged with the same vacancy coming from an ATS. A
 * company's page on DOU has a link to its site, so it's one request per company.
 */
async function resolveDomain(slug: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(slug)) return cache.get(slug)!;

  try {
    const res = await fetchText(`https://jobs.dou.ua/companies/${slug}/`);
    const $ = cheerio.load(res.body);
    const href =
      $('.site a').attr('href') ??
      $('a.site').attr('href') ??
      $('a[href^="http"]')
        .toArray()
        .map((element) => $(element).attr('href') ?? '')
        .find((url) => {
          const domain = normalizeDomain(url);
          return Boolean(
            domain &&
              !/dou\.ua|google|gstatic|facebook|linkedin|youtube|instagram|twitter|x\.com|tiktok|whatsapp|telegram|github/i.test(
                domain,
              ),
          );
        });

    const domain = href ? normalizeDomain(href) : null;
    cache.set(slug, domain);
    return domain;
  } catch {
    cache.set(slug, null);
    return null;
  }
}

/*
 * The identifier is deliberately not 'dou': that name is already taken by the
 * company catalog `src/sources/catalogs/dou.ts`, and two sources with the same id
 * would collide in the registry and in the `runs` table.
 */
export const douBoard: BoardSource = {
  id: 'dou:vacancies',
  kind: 'board',

  parse(payload: string): RawVacancy[] {
    return parseDou(payload);
  },

  async fetch(): Promise<RawVacancy[]> {
    const all = new Map<string, DouVacancy>();
    const domains = new Map<string, string | null>();

    for (const category of DOU_CATEGORIES) {
      try {
        const res = await fetchText(
          `https://jobs.dou.ua/vacancies/?category=${encodeURIComponent(category)}`,
        );
        for (const vacancy of parseDou(res.body)) {
          if (!all.has(vacancy.url)) all.set(vacancy.url, vacancy);
        }
      } catch (error) {
        log.warn({ category, err: String(error) }, 'dou: category failed to load');
      }
    }

    for (const vacancy of all.values()) {
      if (!vacancy.companySlug) continue;
      vacancy.companyDomain = await resolveDomain(vacancy.companySlug, domains);
    }

    return [...all.values()];
  },
};
