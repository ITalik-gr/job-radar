import * as cheerio from 'cheerio';
import { normalizeDomain, normalizeUrl } from '../../lib/normalize.js';
import type { RawCompany } from '../registry.js';
import { cleanTags } from '../../pipeline/backfill-catalog.js';

const SOURCE = 'clutch';

/**
 * Clutch sits behind Cloudflare with active bot detection, so there's no automatic
 * crawl here. The owner saves the catalog page from their browser, and the parser
 * processes it offline. The same approach fits any catalog with the same setup, for
 * example TechBehemoths, which also returns a Cloudflare challenge instead of HTML.
 */

/** The domain hides in the `u` parameter of the r.clutch.co redirect, not in the href itself. */
export function extractDomain(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://clutch.co');
    const target = url.searchParams.get('u');
    if (target) return normalizeDomain(target);
    if (/clutch\.co$/i.test(url.hostname)) return null;
    return normalizeDomain(url.href);
  } catch {
    return null;
  }
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function parse(html: string): RawCompany[] {
  const $ = cheerio.load(html);
  const companies: RawCompany[] = [];

  $('li.provider-list-item').each((_, node) => {
    const card = $(node);
    const name = clean(card.find('.provider__title-link').first().text()) ||
      clean(card.find('[data-title]').first().attr('data-title') ?? '');
    if (!name) return;

    const domain = extractDomain(card.find('a[class*="website-link"]').first().attr('href'));
    const location = clean(card.find('.provider__highlights-item.location').text());
    const country = clean(card.find('[itemprop="addressCountry"]').first().attr('content') ?? '') || null;
    const city = clean(card.find('[itemprop="addressLocality"]').first().attr('content') ?? '') ||
      location.split(',')[0]?.trim() || null;
    const size = clean(card.find('.provider__highlights-item.employees-count').text()) || null;
    const rate = clean(card.find('.provider__highlights-item.hourly-rate').text()) || null;
    const minProject = clean(card.find('.provider__highlights-item.min-project-size').text()) || null;

    // Services sit in chart tooltips in the form "25% Web Development".
    const services = card
      .find('.provider__services-chart-item')
      .map((_, item) => {
        const tooltip = $(item).attr('data-tooltip-content') ?? '';
        const match = /(\d+%)\s*([^<]+)/.exec(cheerio.load(`<i>${tooltip}</i>`).text());
        return match ? clean(match[2] ?? '') : '';
      })
      .get()
      .filter(Boolean);

    // The rating and review count sit in microdata, not in the card's visible text.
    const ratingValue = Number(card.find('[itemprop="ratingValue"]').first().attr('content'));
    const reviewCount = Number(card.find('[itemprop="reviewCount"]').first().attr('content'));

    /*
     * The "Other" block. Every highlight is labeled in its tooltip ("Min. project
     * size", "Employees"), so the label is taken from there instead of being guessed
     * from the class. Known labels already have their own columns, the rest settles
     * here, and a new row on a Clutch card no longer needs either a new column or a parser fix.
     */
    const extra: Record<string, string> = {};
    card.find('.provider__highlights-item').each((_, item) => {
      const node = $(item);
      const label = clean(cheerio.load(`<i>${node.attr('data-tooltip-content') ?? ''}</i>`).text());
      const value = clean(node.text());
      if (!label || !value) return;
      if (/min\.? project|hourly rate|employees|location/i.test(label)) return;
      extra[label] = value;
    });

    if (/verified/i.test(clean(card.find('[class*="verification"], [class*="verified"]').text()))) {
      extra['Verified profile'] = 'yes';
    }

    // The same cleaner as in the backfill: chart percentages and labels aren't tags.
    const tags = cleanTags(services);
    const profile = card.find('.provider__title-link').first().attr('href') ?? null;

    companies.push({
      source: SOURCE,
      name,
      domain,
      country,
      city,
      sizeHint: size,
      careersUrl: null,
      sourceUrl: profile ? normalizeUrl(profile) : null,
      tags,
      description: clean(card.find('.provider__description-text-item, .provider__description').first().text()) || null,
      openVacancies: null,
      rating: Number.isFinite(ratingValue) ? ratingValue : null,
      reviewsCount: Number.isFinite(reviewCount) ? reviewCount : null,
      minProject,
      hourlyRate: rate,
      foundedYear: null,
      extra,
    });
  });

  return companies;
}
