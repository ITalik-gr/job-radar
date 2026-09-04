import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * DOU як борд вакансій, а не як каталог компаній. Найкоротший шлях до українського
 * ринку, і головне, до вилок: ATS-джерела вилку майже ніколи не показують.
 *
 * robots.txt дозволяє `/vacancies/`, заборони там стосуються тільки Yandex і
 * службових ajax-шляхів. Сторінка віддається сервером, тому браузер не потрібен.
 */

/** Категорії DOU. У конфізі, щоб додати нову без правки коду. */
export const DOU_CATEGORIES = ['Front End', 'Node.js', 'Fullstack'];

const COMPANY_URL = /jobs\.dou\.ua\/companies\/([a-z0-9._-]+)\//i;

export interface DouVacancy extends RawVacancy {
  /** Slug компанії на DOU. Потрібен, щоб доважити домен окремим запитом. */
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

    // Назва компанії стоїть у тому самому вузлі, що й favicon, тому беремо саме текст.
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
      // Вилка йде в текст: скоринг і модель читають саме його, окремого поля тут немає.
      rawText: [title, salary, location, description].filter(Boolean).join('\n'),
      companyName,
      companyDomain: null,
      location,
      // "віддалено" це і є ознака віддаленої роботи українською.
      remote: location ? /віддален|remote/i.test(location) : null,
      postedAt: null,
      companySlug,
    });
  });

  return rows;
}

/**
 * Домен компанії на сторінці списку не показується, а без нього вакансія не
 * привʼязується до картки компанії і не зливається з тією самою вакансією з ATS.
 * Сторінка компанії на DOU містить посилання на сайт, тому один запит на компанію.
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
 * Ідентифікатор навмисно не 'dou': під цим іменем уже зареєстрований каталог
 * компаній `src/sources/catalogs/dou.ts`, і два джерела з одним id зіткнулись би
 * у реєстрі і в таблиці `runs`.
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
        log.warn({ category, err: String(error) }, 'dou: категорія не завантажилась');
      }
    }

    for (const vacancy of all.values()) {
      if (!vacancy.companySlug) continue;
      vacancy.companyDomain = await resolveDomain(vacancy.companySlug, domains);
    }

    return [...all.values()];
  },
};
