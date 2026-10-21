import * as cheerio from 'cheerio';
import { fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import type { LeadSource, RawLead } from '../registry.js';

/**
 * Funding news, section 4 of CLAUDE.md: a founder with fresh money is about to spend it, often on
 * the product. A news item names a startup in prose, and picking that name out reliably needs the
 * model (stage 5). Until then a news item is a lead with no company: the owner reads the headline
 * and links it, or skips it. Nothing about the company is guessed here (rule 6).
 *
 * AIN.ua forbids its RSS in robots.txt (every path ending in /feed), so its investments section page is
 * read instead, which robots.txt allows. dev.ua allows its RSS.
 */

/** Money raised or invested: the verbs and round names Ukrainian tech media use. */
const FUNDING =
  /(залучи|інвестува\S* (у|в) |раунд|pre-?seed|\bseed\b|series [a-d]\b|отрима\S* (\S+ )?(інвестиці|грант)|венчурн\S* інвестиці)/i;
/** A fund closing or a company being bought is not a startup with money to spend. */
const NOT_FUNDING = /(придба|закри\S* (\S+ )*фонд|банкрут|об\S?єдну|має намір)/i;
const UKRAINIAN = /(україн|ukrain)/i;

export function isFundingNews(title: string): boolean {
  return FUNDING.test(title) && !NOT_FUNDING.test(title);
}

function newsLead(source: string, url: string, title: string, text: string | null): RawLead {
  return {
    source,
    // The article address is the stable id: a headline gets edited, the address does not.
    externalId: url,
    url,
    title,
    text,
    budget: null,
    currency: null,
    deadlineAt: null,
    company: null,
    contact: null,
  };
}

const AIN_URL = 'https://ain.ua/tech/investments/';

/** The AIN.ua investments section: one `article` per news item, the link and lead paragraph inside. */
export function parseAin(html: string): RawLead[] {
  const $ = cheerio.load(html);
  const leads: RawLead[] = [];
  const seen = new Set<string>();

  $('article').each((_, element) => {
    const link = $(element).find('a[href^="/20"], a[href^="https://ain.ua/20"]').first();
    const href = link.attr('href');
    const paragraphs = link.find('p');
    const title = paragraphs.first().text().replace(/\s+/g, ' ').trim();
    if (!href || !title) return;

    const url = new URL(href, 'https://ain.ua').toString();
    if (seen.has(url) || !isFundingNews(title)) return;
    seen.add(url);

    const text = paragraphs.eq(1).text().replace(/\s+/g, ' ').trim() || null;
    leads.push(newsLead('ain', url, title, text));
  });

  return leads;
}

/** The dev.ua RSS. dev.ua writes about the world too, so only news about Ukrainian companies pass. */
export function parseDevUa(xml: string): RawLead[] {
  const $ = cheerio.load(xml, { xml: true });
  if ($('rss channel').length === 0) throw new Error('dev.ua: the response is not an RSS feed');

  const leads: RawLead[] = [];
  $('item').each((_, element) => {
    const item = $(element);
    const title = item.find('title').first().text().trim();
    const url = item.find('link').first().text().trim();
    const text = item.find('description').first().text().replace(/\s+/g, ' ').trim() || null;
    if (!title || !url || !isFundingNews(title)) return;
    if (!UKRAINIAN.test(`${title} ${text ?? ''}`)) return;
    leads.push(newsLead('devua', url, title, text));
  });
  return leads;
}

export const ainFunding: LeadSource = {
  id: 'ain',
  kind: 'lead',
  async fetch() {
    const { body } = await fetchText(AIN_URL);
    const seen = cheerio.load(body)('article').length;
    const leads = parseAin(body);
    log.info({ seen, funding: leads.length }, 'AIN investments page parsed');
    return { leads, seen };
  },
  parse(payload: string) {
    return parseAin(payload);
  },
};

export const devuaFunding: LeadSource = {
  id: 'devua',
  kind: 'lead',
  async fetch() {
    const { body } = await fetchText('https://dev.ua/rss');
    return { leads: parseDevUa(body), seen: cheerio.load(body, { xml: true })('item').length };
  },
  parse(payload: string) {
    return parseDevUa(payload);
  },
};
