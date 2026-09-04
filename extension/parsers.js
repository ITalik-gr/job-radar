/**
 * Розбір карток каталогів. Кожен сайт має свій набір селекторів, а якщо жоден
 * не підійшов, працює запасний шлях через JSON-LD, який віддає більшість каталогів.
 *
 * Розбирається сторінка, яку відкрив користувач у своєму браузері. Нічого не
 * обходиться: навігацією керує людина, скрипт лише читає готовий DOM.
 */
(() => {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  const SOCIAL = /(facebook|twitter|x\.com|linkedin|instagram|youtube|tiktok|pinterest|google|schema\.org|w3\.org|gstatic|gravatar|cloudflare|clutch\.co|goodfirms|designrush|sortlist|themanifest|upcity|techbehemoths|awwwards|wadline|dou\.ua)/i;

  function domainFrom(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      // Каталоги ховають сайт компанії в параметрі редиректу.
      const inner =
        url.searchParams.get('u') ||
        url.searchParams.get('url') ||
        url.searchParams.get('redirect') ||
        url.searchParams.get('target') ||
        url.searchParams.get('website');
      const target = inner ? new URL(inner) : url;
      const host = target.hostname.replace(/^www\./, '').toLowerCase();
      if (!host.includes('.')) return null;
      if (SOCIAL.test(host)) return null;
      if (host === window.location.hostname.replace(/^www\./, '')) return null;
      return host;
    } catch {
      return null;
    }
  }

  const text = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = clean(node?.textContent);
      if (value) return value;
    }
    return null;
  };

  const href = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = node?.getAttribute('href');
      if (value) return value;
    }
    return null;
  };

  /*
   * База для відносних посилань це повна поточна адреса, а не origin.
   *
   * Пагінація на каталогах часто виглядає як href="?page=2". Від origin таке
   * посилання розкривалось у "https://clutch.co/?page=2", тобто на головну
   * замість наступної сторінки списку, і обхід зривався на першому ж переході.
   */
  const absolute = (path) => {
    if (!path) return null;
    try {
      return new URL(path, window.location.href).href;
    } catch {
      return null;
    }
  };

  // Розмір команди легко сплутати з бюджетом ("$10,000+"), тому число з доларом не рахуємо.
  const SIZE = /(?<![$\d])\b\d{1,3}(?:,\d{3})?\s*(?:[-\u2013\u2014]|to)\s*\d{1,3}(?:,\d{3})?\b(?!\s*\/?\s*hr)|(?<![$\d])\b\d{1,3},?\d{0,3}\+\s*(?:employees|people|staff|специалист|спеціаліст)/i;
  const RATE = /\$\s?\d+\s*(?:[-\u2013\u2014]|to)\s*\$?\d+\s*\/?\s*hr/i;
  const MIN_PROJECT = /\$\s?[\d,]+\+/;

  const TAG_NOISE = /(allocation|expertise by|read more|see profile|\+\d+\s*service|^\d+%$|view profile|visit website)/i;

  function tagsFrom(card) {
    const nodes = card.querySelectorAll(
      '[class*="service" i], [class*="tag" i], [class*="skill" i], [class*="focus" i], [class*="expertise" i]',
    );

    const seen = new Set();
    const tags = [];
    for (const node of nodes) {
      const raw = clean(node.getAttribute('data-tooltip-content') || node.textContent)
        .replace(/<[^>]*>/g, '')
        .replace(/^\d+%\s*/, '')
        .replace(/\s*\+\d+\s*services?$/i, '');

      if (!raw || raw.length < 2 || raw.length > 40) continue;
      if (TAG_NOISE.test(raw)) continue;

      // Ключ без пробілів і невидимих символів: інакше "Mobile App Development"
      // і той самий тег з нерозривним пробілом рахуються як різні.
      const key = raw.toLowerCase().replace(/[^a-z0-9а-яіїєґ]/gi, '');
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(raw);
      if (tags.length >= 12) break;
    }
    return tags;
  }

  function common(card) {
    const cardText = clean(card.textContent);
    // Явний елемент із кількістю людей надійніший за регексп по всьому тексту картки.
    const sizeNode = text(card, [
      '.employees-count',
      '[class*="employee" i]',
      '[class*="team-size" i]',
      '[class*="company-size" i]',
    ]);

    return {
      sizeHint: (sizeNode && (sizeNode.match(SIZE) || [])[0]) || (cardText.match(SIZE) || [])[0] || null,
      rate: (cardText.match(RATE) || [])[0] || null,
      minProject: (cardText.match(MIN_PROJECT) || [])[0] || null,
      description: text(card, ['[class*="description" i]', '[class*="summary" i]', '[class*="tagline" i]', 'p']),
      city:
        text(card, [
          '[itemprop="addressLocality"]',
          '[class*="location" i]',
          '[class*="address" i]',
          '[class*="city" i]',
        ]) || null,
      country: card.querySelector('[itemprop="addressCountry"]')?.getAttribute('content') || null,
    };
  }

  /** Опис одного каталогу: як знайти картки, назву, сайт і профіль. */
  const SITES = [
    {
      id: 'clutch.co',
      match: /clutch\.co$/,
      cards: 'li.provider-list-item, .provider-row',
      name: (card) => text(card, ['.provider__title-link', 'h3 a']) || clean(card.getAttribute('data-title')),
      website: (card) => href(card, ['a[class*="website-link"]', 'a[data-link_text*="Visit Website"]']),
      profile: (card) => href(card, ['.provider__title-link', 'a[href*="/profile/"]']),
      next: () => href(document, ['a[rel="next"]', '.page-item.next a', 'a.sg-pagination__next']),
    },
    {
      id: 'goodfirms.co',
      match: /goodfirms\.co$/,
      cards: '.firm-wrapper, li[class*="firm"], .directory-list li, [class*="company-detail"]',
      name: (card) => text(card, ['.company-name a', 'h3 a', 'h2 a']),
      website: (card) => href(card, ['a[class*="visit-website"]', 'a[href*="/visit-website"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['.company-name a', 'h3 a']),
      next: () => href(document, ['a[rel="next"]', '.pagination a.next']),
    },
    {
      id: 'designrush.com',
      match: /designrush\.com$/,
      cards: '[class*="agency-card"], [class*="company-card"], .listing-item, article[class*="agency"]',
      name: (card) => text(card, ['[class*="title"] a', 'h3 a', 'h2 a', 'h3', 'h2']),
      website: (card) => href(card, ['a[class*="website"]', 'a[href*="visit"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['a[href*="/agency/"]', 'h3 a', 'h2 a']),
      next: () => href(document, ['a[rel="next"]', 'a.next']),
    },
    {
      id: 'sortlist.com',
      match: /sortlist\.com$/,
      cards: '[data-testid*="agency"], [class*="agency-card"], article',
      name: (card) => text(card, ['h2 a', 'h3 a', 'h2', 'h3']),
      website: (card) => href(card, ['a[href*="/website"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['a[href*="/agency/"]', 'h2 a', 'h3 a']),
      next: () => href(document, ['a[rel="next"]', 'a[aria-label*="Next"]']),
    },
    {
      id: 'themanifest.com',
      match: /themanifest\.com$/,
      cards: 'li.provider-list-item, .provider-row, [class*="company-card"]',
      name: (card) => text(card, ['.provider__title-link', 'h3 a', 'h2 a']),
      website: (card) => href(card, ['a[class*="website"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['a[href*="/profile/"]', 'h3 a']),
      next: () => href(document, ['a[rel="next"]', '.pager__item--next a']),
    },
    {
      id: 'upcity.com',
      match: /upcity\.com$/,
      cards: '[class*="provider-card"], [class*="listing-card"], article',
      name: (card) => text(card, ['h2 a', 'h3 a', 'h2', 'h3']),
      website: (card) => href(card, ['a[class*="website"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['a[href*="/profiles/"]', 'h2 a']),
      next: () => href(document, ['a[rel="next"]', 'a.next']),
    },
    {
      id: 'techbehemoths.com',
      match: /techbehemoths\.com$/,
      cards: '[class*="company-item"], [class*="company-card"], article[class*="company"]',
      name: (card) => text(card, ['[class*="company-name"]', 'h2 a', 'h3 a', 'h2', 'h3']),
      website: (card) => href(card, ['a[class*="website"]', 'a[rel="nofollow"][target="_blank"]']),
      profile: (card) => href(card, ['a[href*="/company/"]', 'h2 a', 'h3 a']),
      next: () => href(document, ['a[rel="next"]', 'a.next']),
    },
    {
      id: 'jobs.dou.ua',
      match: /dou\.ua$/,
      cards: 'li.l-company',
      name: (card) => text(card, ['a.cn-a']),
      website: () => null,
      profile: (card) => href(card, ['a.cn-a']),
      next: () => null,
    },
  ];

  /** Наступна сторінка: спершу опис сайту, далі загальні ознаки пагінації. */
  const GENERIC_NEXT = [
    'a[rel="next"]',
    'link[rel="next"]',
    'a[aria-label*="Next" i]',
    'a[aria-label*="наступ" i]',
    'a[class*="next" i]:not([class*="context" i])',
    '.pagination a[class*="next" i]',
    '.pager__item--next a',
    'li.next a',
  ];

  function genericNext() {
    for (const selector of GENERIC_NEXT) {
      const node = document.querySelector(selector);
      const value = node?.getAttribute('href');
      if (!value || value.startsWith('#')) continue;
      if (node.getAttribute('aria-disabled') === 'true') continue;
      if (node.closest('[class*="disabled" i]')) continue;
      return value;
    }
    return null;
  }

  function siteFor(hostname) {
    return SITES.find((site) => site.match.test(hostname.replace(/^www\./, ''))) ?? null;
  }

  /** Загальні селектори на випадок незнайомого каталогу. */
  const GENERIC_CARDS = [
    'li[class*="provider" i]',
    '[class*="agency-card" i]',
    '[class*="company-card" i]',
    '[class*="provider-card" i]',
    '[itemtype*="LocalBusiness"]',
    '[itemtype*="Organization"]',
    'article[class*="company" i]',
    'li[class*="company" i]',
  ];

  function parseCards(site) {
    const selector = site?.cards ?? GENERIC_CARDS.join(', ');
    let cards = [...document.querySelectorAll(selector)];
    if (cards.length < 2 && site) cards = [...document.querySelectorAll(GENERIC_CARDS.join(', '))];
    if (cards.length < 2) return [];

    return cards
      .map((card) => {
        const base = common(card);
        const name = site?.name(card) ?? text(card, ['h3 a', 'h2 a', '[itemprop="name"]', 'h3', 'h2']);
        if (!name) return null;

        const website = site?.website(card) ?? href(card, ['a[class*="website" i]', 'a[rel="nofollow"][target="_blank"]']);
        const profile = site?.profile(card) ?? href(card, ['a[href*="/profile"]', 'a[href*="/company"]', 'h3 a', 'h2 a']);

        return {
          name,
          domain: domainFrom(website),
          city: base.city,
          country: base.country,
          sizeHint: base.sizeHint,
          tags: [...new Set([...tagsFrom(card), base.rate, base.minProject].filter(Boolean))],
          description: base.description,
          sourceUrl: absolute(profile),
        };
      })
      .filter(Boolean);
  }

  /** Запасний шлях: ItemList у JSON-LD. Дає назви і профілі, домен рідше. */
  function parseJsonLd() {
    const items = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue;
      }
      const entries = [].concat(data['@graph'] ?? [], data.itemListElement ?? [], data);
      for (const entry of entries) {
        const org = entry?.item ?? entry;
        if (!org || typeof org !== 'object') continue;
        if (!['Organization', 'LocalBusiness', 'ProfessionalService'].includes(org['@type'])) continue;

        items.push({
          name: clean(org.name),
          domain: domainFrom(Array.isArray(org.sameAs) ? org.sameAs[0] : org.sameAs || org.url),
          city: org.address?.addressLocality ?? null,
          country: org.address?.addressCountry ?? null,
          sizeHint: org.numberOfEmployees?.value ? String(org.numberOfEmployees.value) : null,
          tags: [],
          description: clean(org.description) || null,
          sourceUrl: org.url ?? null,
        });
      }
    }
    return items.filter((item) => item.name);
  }

  window.JobRadarParsers = {
    parse() {
      const site = siteFor(window.location.hostname);
      const fromCards = parseCards(site);
      const items = fromCards.length > 0 ? fromCards : parseJsonLd();
      const unique = new Map();
      for (const item of items) unique.set(`${item.name}|${item.domain ?? ''}`, item);

      return {
        site: site?.id ?? window.location.hostname.replace(/^www\./, ''),
        known: Boolean(site),
        method: fromCards.length > 0 ? 'cards' : 'json-ld',
        items: [...unique.values()],
        nextPage: absolute(site?.next?.() ?? genericNext()),
      };
    },
  };
})();
