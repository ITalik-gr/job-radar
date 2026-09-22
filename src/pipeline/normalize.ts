import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { htmlToText } from '../lib/html.js';
import { normalizeUrl } from '../lib/normalize.js';

/**
 * Normalizing a page before hashing. The most important place in the project: if this is
 * done poorly, the hash will change every day and the system will drown in false alerts.
 * The order of the rules matters, dates are cleaned before whitespace collapses.
 */

const DROP_SELECTORS = [
  'script',
  'style',
  'svg',
  'noscript',
  'iframe',
  'head',
  'link',
  'meta',
  'form[action*="csrf"]',
  'input[type="hidden"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="onetrust" i]',
  '[class*="gdpr" i]',
  '[id*="intercom" i]',
  '[class*="intercom" i]',
  '[id*="drift" i]',
  '[class*="crisp" i]',
  '[id*="hubspot-messages" i]',
  '[class*="chat-widget" i]',
  '[class*="livechat" i]',
  '[aria-label*="chat" i]',
  'footer',
  '[class*="copyright" i]',
  '[class*="breadcrumb" i]',
].join(', ');

const NOISE_PATTERNS: [RegExp, string][] = [
  // Relative time in English and Ukrainian.
  [/\b(posted|updated|published|added)?\s*\b\d+\s*(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, ' '],
  // \b doesn't work for Cyrillic, it's outside ASCII, so word boundaries go through lookaround.
  [/(?<![\p{L}\d])\d+\s*(секунд|хвилин|годин|дн|день|дні|тижн|місяц|рок)[\p{L}]*\s+тому(?![\p{L}])/giu, ' '],
  [/(?<![\p{L}])(щойно|сьогодні|вчора|позавчора)(?![\p{L}])/giu, ' '],
  [/\b(just now|today|yesterday)\b/gi, ' '],
  // Absolute dates in common formats.
  [/\b\d{4}-\d{2}-\d{2}(t[\d:.,+-]*z?)?\b/gi, ' '],
  [/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, ' '],
  [
    /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december|січн|лют|березн|квітн|травн|червн|липн|серпн|вересн|жовтн|листопад|грудн)\w*\.?\,?\s*\d{0,4}\b/gi,
    ' ',
  ],
  [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2},?\s*\d{0,4}\b/gi,
    ' ',
  ],
  // Time of day.
  [/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, ' '],
  // View, applicant and review counters.
  [/\b\d[\d\s,.']*\s*(views?|viewed|applicants?|applications?|candidates?|clicks?)\b/gi, ' '],
  [/\b(viewed|seen)\s+\d[\d\s,.']*\s*times?\b/gi, ' '],
  [/\b\d[\d\s,.']*\s*(people|others)\s+(applied|viewed|clicked)\b/gi, ' '],
  [/(?<![\p{L}\d])\d[\d\s,.']*\s*(перегляд|відгук|кандидат|заявк|відкли)[\p{L}]*(?![\p{L}])/giu, ' '],
  // Random hashes: build ids, nonces, ETags that ended up in the text.
  [/\b(?=[a-f0-9]*\d)[a-f0-9]{8,64}\b/gi, ' '],
  [/\b[a-z0-9_-]{22,}\b/gi, ' '],
  // Copyright year, if it survived the footer being dropped.
  [/©\s*\d{4}(\s*[-–]\s*\d{4})?/g, ' '],
  [/\b(copyright|all rights reserved)\b/gi, ' '],
];

const KEEP_ATTRS = new Set(['href']);

/** Strips tracking parameters from href, keeps the stable part of the link. */
export function cleanHref(href: string | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value || value.startsWith('#') || value.startsWith('javascript:')) return null;
  if (value.startsWith('mailto:') || value.startsWith('tel:')) return value.toLowerCase();
  if (/^https?:\/\//i.test(value)) return normalizeUrl(value);

  // A relative link: clean the parameters by hand, with no made-up domain in the result.
  const [path, query = ''] = value.split('?');
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (/^(utm_|ref$|referrer$|gh_src$|source$|fbclid$|gclid$)/i.test(key)) params.delete(key);
  }
  const rest = params.toString();
  const cleanPath = path!.length > 1 ? path!.replace(/\/$/, '') : path!;
  return (rest ? `${cleanPath}?${rest}` : cleanPath).toLowerCase();
}

export function scrubText(input: string): string {
  let text = input.toLowerCase().replace(/ /g, ' ');
  for (const [pattern, replacement] of NOISE_PATTERNS) text = text.replace(pattern, replacement);
  return text
    .split('\n')
    .map((line) => line.replace(/[\t\f\r ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function stripNoise($: cheerio.CheerioAPI): void {
  $(DROP_SELECTORS).remove();
  $('*')
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove();

  $('*').each((_, node) => {
    const el = node as Element;
    for (const attr of Object.keys(el.attribs ?? {})) {
      if (!KEEP_ATTRS.has(attr)) delete el.attribs[attr];
    }
    const href = cleanHref(el.attribs?.href);
    if (el.attribs && 'href' in el.attribs) {
      if (href) el.attribs.href = href;
      else delete el.attribs.href;
    }
  });
}

export function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

export interface PageBlock {
  hash: string;
  text: string;
  url: string | null;
  title: string | null;
}

export interface NormalizedPage {
  text: string;
  contentHash: string;
  blocks: PageBlock[];
}

const JOB_HREF = /(job|jobs|career|careers|vacanc|vakans|position|opening|opportunit|apply|hiring|robota)/i;
const BLOCK_SELECTOR =
  'li, article, tr, .card, [class*="job" i], [class*="vacanc" i], [class*="position" i], [class*="opening" i], [class*="career" i]';

function textOf($: cheerio.CheerioAPI, node: AnyNode): string {
  return scrubText($(node).text());
}

/**
 * Candidate blocks: list items and cards that contain a link that looks like a vacancy.
 * Nested candidates are dropped, only the outermost one remains.
 */
export function extractBlocks($: cheerio.CheerioAPI): PageBlock[] {
  const candidates: Element[] = [];

  $(BLOCK_SELECTOR).each((_, node) => {
    const el = node as Element;
    const link = $(el).find('a[href]').first();
    const href = cleanHref(link.attr('href'));
    if (!href || !JOB_HREF.test(href)) return;
    if (candidates.some((picked) => $.contains(picked, el))) return;
    candidates.push(el);
  });

  // Fallback: a page with no cards, just links.
  if (candidates.length === 0) {
    $('a[href]').each((_, node) => {
      const el = node as Element;
      const href = cleanHref(el.attribs?.href);
      if (href && JOB_HREF.test(href)) candidates.push(el);
    });
  }

  const seen = new Set<string>();
  const blocks: PageBlock[] = [];

  for (const el of candidates) {
    const link = $(el).is('a') ? $(el) : $(el).find('a[href]').first();
    const url = cleanHref(link.attr('href'));
    const text = textOf($, el);
    if (text.length < 3) continue;

    const blockHash = hash(`${url ?? ''}|${text}`);
    if (seen.has(blockHash)) continue;
    seen.add(blockHash);

    blocks.push({
      hash: blockHash,
      text,
      url,
      title: titleOf(link.html()) || null,
    });
  }

  return blocks;
}

/**
 * The vacancy title is the first line of the link. We take exactly the first one,
 * because a card often also wraps the location and "read more", which stick to the
 * title without line breaks.
 */
function titleOf(innerHtml: string | null): string | null {
  if (!innerHtml) return null;
  const [first] = scrubText(htmlToText(innerHtml)).split('\n');
  return first?.trim() || null;
}

export function normalizePage(html: string): NormalizedPage {
  const $ = cheerio.load(html);
  stripNoise($);

  const blocks = extractBlocks($);
  const text = scrubText($('body').length > 0 ? $('body').text() : $.root().text());

  return { text, contentHash: hash(text), blocks };
}
