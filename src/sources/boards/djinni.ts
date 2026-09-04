import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * Djinni як борд вакансій. Разом з DOU це український ринок з вилками, яких
 * ATS-джерела не дають майже ніколи.
 *
 * robots.txt дозволяє `/jobs`, заборонені лише `/jobs2`, `/q`, `/developers`,
 * `/free-jobs` і `/set_lang`. Сторінка віддається сервером, браузер не потрібен.
 *
 * Домену компанії тут немає і взяти його нізвідки: Djinni навмисно не веде на
 * сайт роботодавця, а частина вакансій узагалі анонімна. Тому такі записи
 * привʼязуються лише до компаній, які вже є в базі під тією самою назвою,
 * а нових не створюють. Вигадувати домен не можна, це правило 6 в CLAUDE.md.
 */

/** Ключові слова Djinni. У конфізі, щоб додати нове без правки коду. */
export const DJINNI_KEYWORDS = ['JavaScript', 'Fullstack', 'Node.js'];

export function parseDjinni(html: string): RawVacancy[] {
  const $ = cheerio.load(html);
  const rows: RawVacancy[] = [];

  $('[id^="job-item-"]').each((_, element) => {
    const card = $(element);
    const externalId = (card.attr('id') ?? '').replace('job-item-', '') || null;

    const link = card.find('a.job_item__header-link').first().attr('href');
    const title = card.find('.job-item__position').first().text().trim();
    if (!link || !title) return;

    /*
     * У частини карток на місці назви компанії стоїть число (лічильник переглядів
     * в анонімних вакансіях). Чисто числова "назва" це не компанія, і краще null,
     * ніж сміття: правило 6 в CLAUDE.md.
     */
    const rawCompany = card.find('.job_item__header-link span.small').first().text().trim();
    const companyName = rawCompany && !/^\d+$/.test(rawCompany) ? rawCompany : null;
    const location = card.find('.location-text').first().text().trim() || null;

    /*
     * Djinni показує не саму вилку, а її рівень значками долара, і окремо текст
     * умов. Кладемо весь видимий текст картки: скоринг і модель читають `rawText`,
     * і краще дати їм більше, ніж вигадати число, якого на сторінці немає.
     */
    const body = card.text().replace(/\s+/g, ' ').trim();

    rows.push({
      source: 'djinni',
      externalId,
      url: new URL(link, 'https://djinni.co').href,
      title,
      rawText: [title, companyName, location, body].filter(Boolean).join('\n'),
      companyName,
      companyDomain: null,
      location,
      remote: /тільки віддалено|remote only|віддалено/i.test(body),
      postedAt: null,
    });
  });

  return rows;
}

export const djinni: BoardSource = {
  id: 'djinni',
  kind: 'board',

  parse(payload: string): RawVacancy[] {
    return parseDjinni(payload);
  },

  async fetch(): Promise<RawVacancy[]> {
    const all = new Map<string, RawVacancy>();

    for (const keyword of DJINNI_KEYWORDS) {
      try {
        const res = await fetchText(
          `https://djinni.co/jobs/?primary_keyword=${encodeURIComponent(keyword)}`,
        );
        for (const vacancy of parseDjinni(res.body)) {
          if (!all.has(vacancy.url)) all.set(vacancy.url, vacancy);
        }
      } catch (error) {
        log.warn({ keyword, err: String(error) }, 'djinni: запит не вдався');
      }
    }

    return [...all.values()];
  },
};
