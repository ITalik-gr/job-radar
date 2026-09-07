import { anyToText } from '../../lib/html.js';
import { fetchJson } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * "Ask HN: Who is hiring?", щомісячна гілка на Hacker News.
 *
 * Найгустіше джерело стартапів із тих, що взагалі є: дві сотні компаній на
 * місяць, майже всі маленькі, майже всі з прямим контактом засновника, і жодна
 * з них не платить рекрутинговому агентству. Саме те, чого не дають ATS-борди.
 *
 * Ходимо через Algolia API самого HN: публічний, без ключів, віддає гілку одним
 * JSON. Скрейпити сторінку не треба.
 */

const SOURCE = 'hn:hiring';
const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';
const ITEM = 'https://hn.algolia.com/api/v1/items';

interface AlgoliaHit {
  objectID: string;
  title?: string;
  created_at_i?: number;
}

interface AlgoliaComment {
  id: number;
  text?: string | null;
  created_at_i?: number;
  children?: AlgoliaComment[];
}

interface AlgoliaItem {
  id: number;
  title?: string;
  children?: AlgoliaComment[];
}

/**
 * Заголовок оголошення це перший рядок, розділений вертикальними рисками:
 * "Company | Role | Location | REMOTE | $150k | https://...".
 *
 * Формат не стандарт, а звичай, тому все, крім назви компанії, необовʼязкове.
 * Порожні поля лишаються порожніми, а не вгадуються.
 */
export function parseHeader(line: string): {
  company: string | null;
  title: string | null;
  location: string | null;
  remote: boolean | null;
} {
  const parts = line
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return { company: null, title: null, location: null, remote: null };

  const rest = parts.slice(1);
  const remote = /\bremote\b/i.test(line) ? true : /\bonsite|on-site|hybrid\b/i.test(line) ? false : null;

  /*
   * Роль це перший шматок після назви, який схожий на посаду. Інакше в назву
   * ролі потрапляє "Full-time" або вилка, і вакансія стає "Acme, $150k".
   */
  const roleWords =
    /engineer|developer|designer|scientist|manager|lead|architect|devops|sre|swe|sde|analyst|intern|founder|cto|programmer|full-?stack|front-?end|back-?end/i;
  const title = rest.find((part) => roleWords.test(part)) ?? null;

  const skip = /remote|onsite|on-site|hybrid|full-?time|part-?time|contract|intern|visa|\$|€|£|\d{2,}k/i;
  const location =
    rest.find((part) => part !== title && !skip.test(part) && /[a-z]/i.test(part)) ??
    (remote ? 'Remote' : null);

  return { company: parts[0]!, title, location, remote };
}

/** Перше зовнішнє посилання в оголошенні. Воно ж дає домен компанії. */
export function firstLink(html: string): string | null {
  const matches = html.matchAll(/href="([^"]+)"/g);
  for (const match of matches) {
    const url = match[1]!.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
    if (url.includes('news.ycombinator.com')) continue;
    if (!url.startsWith('http')) continue;
    return url;
  }
  return null;
}

export function parseHnThread(payload: string): RawVacancy[] {
  const item = JSON.parse(payload) as AlgoliaItem;
  const posts: RawVacancy[] = [];

  for (const comment of item.children ?? []) {
    const html = comment.text ?? '';
    if (!html) continue;

    const text = anyToText(html);
    const header = text.split('\n')[0] ?? '';
    const { company, title, location, remote } = parseHeader(header);
    if (!company) continue;

    const link = firstLink(html);
    /*
     * Без домену вакансія однаково не збережеться: компанія створюється лише
     * коли є і назва, і домен, а вигадувати домен з назви не можна.
     */
    const domain = link ? normalizeDomain(link) : null;
    if (!domain) continue;

    posts.push({
      source: SOURCE,
      externalId: String(comment.id),
      // Посилання на сам коментар: там і оригінал тексту, і контакт для відповіді.
      url: `https://news.ycombinator.com/item?id=${comment.id}`,
      title,
      rawText: text,
      companyName: company,
      companyDomain: domain,
      location,
      remote,
      postedAt: comment.created_at_i ? comment.created_at_i * 1000 : null,
    });
  }

  log.debug({ found: posts.length, total: item.children?.length ?? 0 }, 'HN who is hiring розібрано');
  return posts;
}

/** Найсвіжіша гілка "Who is hiring". Сусідня "Who wants to be hired" не потрібна. */
export async function latestThreadId(): Promise<string | null> {
  const body = await fetchJson<{ hits?: AlgoliaHit[] }>(SEARCH);
  const hit = (body.hits ?? []).find((row) => /who is hiring/i.test(row.title ?? ''));
  return hit?.objectID ?? null;
}

export const hnHiring: BoardSource = {
  id: SOURCE,
  kind: 'board',
  async fetch() {
    const id = await latestThreadId();
    if (!id) throw new Error('HN: не знайшов свіжої гілки "Who is hiring"');

    return parseHnThread(JSON.stringify(await fetchJson<AlgoliaItem>(`${ITEM}/${id}`)));
  },
  parse(payload: string) {
    return parseHnThread(payload);
  },
};
