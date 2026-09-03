import * as cheerio from 'cheerio';
import { anyToText } from '../../lib/html.js';
import { fetchText } from '../../lib/http.js';
import { normalizeUrl } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

export interface FeedItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  description: string;
  pubDate: number | null;
  /** Довільні одиничні теги фіду: region, company, location, type тощо. */
  extra: Record<string, string>;
}

export interface FeedConfig {
  id: string;
  url: string;
  /** Ключі додаткових тегів, які варто витягнути з item. */
  extraTags?: string[];
  company?(item: FeedItem): string | null;
  title?(item: FeedItem): string | null;
  location?(item: FeedItem): string | null;
  remote?(item: FeedItem): boolean | null;
}

export function parseFeedItems(payload: string, extraTags: string[] = []): FeedItem[] {
  const $ = cheerio.load(payload, { xmlMode: true });
  const items = $('item').length > 0 ? $('item') : $('entry');

  return items
    .map((_, el) => {
      const node = $(el);
      const text = (selector: string): string => node.children(selector).first().text().trim();
      const link = text('link') || node.children('link').first().attr('href') || null;
      const pub = text('pubDate') || text('published') || text('updated');
      const extra: Record<string, string> = {};
      for (const tag of extraTags) {
        const value = text(tag);
        if (value) extra[tag] = value;
      }

      return {
        title: text('title') || null,
        link,
        guid: text('guid') || null,
        description: text('description') || text('content:encoded') || text('summary'),
        pubDate: pub ? Date.parse(pub) || null : null,
        extra,
      } satisfies FeedItem;
    })
    .get();
}

export function createRssSource(feed: FeedConfig): BoardSource {
  const parse = (payload: string, _ctx: SourceContext = {}): RawVacancy[] => {
    const items = parseFeedItems(payload, feed.extraTags);

    return items.map((item) => {
      const url = item.link ?? item.guid ?? '';
      const location = feed.location?.(item) ?? null;
      const remote = feed.remote?.(item) ?? (location ? /remote|anywhere|worldwide/i.test(location) : null);

      return {
        source: feed.id,
        externalId: item.guid ?? item.link,
        url: normalizeUrl(url) ?? url,
        title: (feed.title?.(item) ?? item.title)?.trim() ?? null,
        rawText: anyToText(item.description),
        companyName: feed.company?.(item)?.trim() ?? null,
        companyDomain: null,
        location,
        remote,
        postedAt: item.pubDate,
      } satisfies RawVacancy;
    });
  };

  return {
    id: feed.id,
    kind: 'board',
    parse,
    async fetch(ctx: SourceContext) {
      const res = await fetchText(feed.url, { headers: { accept: 'application/rss+xml, application/xml' } });
      return parse(res.body, ctx);
    },
  };
}
