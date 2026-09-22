import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * Djinni as a vacancy board. Together with DOU this is the Ukrainian market with
 * salary ranges, which ATS sources almost never give.
 *
 * robots.txt allows `/jobs`, only `/jobs2`, `/q`, `/developers`, `/free-jobs` and
 * `/set_lang` are disallowed. The page is served by the server, no browser needed.
 *
 * There's no company domain here and nowhere to get one from: Djinni deliberately
 * doesn't link to the employer's site, and some vacancies are anonymous altogether.
 * So such records are only linked to companies already in the database under the same
 * name, and new ones aren't created. Making up a domain isn't allowed, that's rule 6 in CLAUDE.md.
 */

/** Djinni keywords. In config, so a new one can be added without touching code. */
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
     * On some cards, a number stands where the company name should be (a view
     * counter on anonymous vacancies). A purely numeric "name" is not a company, and
     * null is better than garbage: rule 6 in CLAUDE.md.
     */
    const rawCompany = card.find('.job_item__header-link span.small').first().text().trim();
    const companyName = rawCompany && !/^\d+$/.test(rawCompany) ? rawCompany : null;
    const location = card.find('.location-text').first().text().trim() || null;

    /*
     * Djinni doesn't show the salary range itself, only its level as dollar-sign
     * icons, plus separate condition text. So the whole visible card text is stored:
     * scoring and the model read `rawText`, and it's better to give them more than
     * to make up a number that isn't on the page.
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
        log.warn({ keyword, err: String(error) }, 'djinni: request failed');
      }
    }

    return [...all.values()];
  },
};
