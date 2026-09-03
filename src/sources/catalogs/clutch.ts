import * as cheerio from 'cheerio';
import { normalizeDomain, normalizeUrl } from '../../lib/normalize.js';
import type { RawCompany } from '../registry.js';

const SOURCE = 'clutch';

/**
 * Clutch за Cloudflare з активним бот-детектом, тому автоматичного обходу тут немає.
 * Власник зберігає сторінку каталогу з браузера, парсер обробляє її офлайн.
 * Той самий підхід підходить будь-якому каталогу з такою ж карткою, наприклад
 * TechBehemoths, який теж віддає Cloudflare-челендж замість HTML.
 */

/** Домен ховається в параметрі `u` редиректу r.clutch.co, а не в самому href. */
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

    // Послуги лежать у тултипах діаграми у вигляді "25% Web Development".
    const services = card
      .find('.provider__services-chart-item')
      .map((_, item) => {
        const tooltip = $(item).attr('data-tooltip-content') ?? '';
        const match = /(\d+%)\s*([^<]+)/.exec(cheerio.load(`<i>${tooltip}</i>`).text());
        return match ? clean(match[2] ?? '') : '';
      })
      .get()
      .filter(Boolean);

    const tags = [...new Set([...services, rate, minProject].filter((tag): tag is string => Boolean(tag)))];
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
    });
  });

  return companies;
}
