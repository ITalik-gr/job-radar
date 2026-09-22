import { anyToText } from '../../lib/html.js';
import { fetchJson } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy } from '../registry.js';

/**
 * "Ask HN: Who is hiring?", a monthly thread on Hacker News.
 *
 * The densest source of startups there is at all: two hundred companies a month,
 * almost all small, almost all with direct founder contact, and none of them pay a
 * recruiting agency. Exactly what ATS boards don't give.
 *
 * We go through HN's own Algolia API: public, no keys, returns the whole thread as
 * one JSON. No need to scrape the page.
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
 * A posting's header is the first line, split by vertical bars:
 * "Company | Role | Location | REMOTE | $150k | https://...".
 *
 * The format is a convention, not a standard, so everything except the company name
 * is optional. Empty fields stay empty rather than being guessed.
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
   * The role is the first chunk after the name that looks like a job title.
   * Otherwise "Full-time" or a salary range ends up as the role, and the vacancy
   * becomes "Acme, $150k".
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

/** The first external link in the posting. It also gives the company domain. */
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
     * Without a domain the vacancy won't be saved anyway: a company is only created
     * when there's both a name and a domain, and a domain can't be made up from a name.
     */
    const domain = link ? normalizeDomain(link) : null;
    if (!domain) continue;

    posts.push({
      source: SOURCE,
      externalId: String(comment.id),
      // A link to the comment itself: it holds both the original text and the reply contact.
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

  log.debug({ found: posts.length, total: item.children?.length ?? 0 }, 'HN who is hiring parsed');
  return posts;
}

/** The most recent "Who is hiring" thread. The neighboring "Who wants to be hired" isn't needed. */
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
    if (!id) throw new Error('HN: could not find a recent "Who is hiring" thread');

    return parseHnThread(JSON.stringify(await fetchJson<AlgoliaItem>(`${ITEM}/${id}`)));
  },
  parse(payload: string) {
    return parseHnThread(payload);
  },
};
