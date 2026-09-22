/**
 * Parsing catalog cards. Every site has its own set of selectors, and if none of
 * them fit, a fallback path through JSON-LD kicks in, which most catalogs provide.
 *
 * The page being parsed is the one the user opened in their own browser. Nothing
 * navigates on its own: a human drives the navigation, the script only reads the
 * DOM that is already there.
 */
(() => {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  const SOCIAL = /(facebook|twitter|x\.com|linkedin|instagram|youtube|tiktok|pinterest|google|schema\.org|w3\.org|gstatic|gravatar|cloudflare|clutch\.co|goodfirms|designrush|sortlist|themanifest|upcity|techbehemoths|awwwards|wadline|dou\.ua)/i;

  function domainFrom(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      // Catalogs hide the company's site in a redirect parameter.
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
   * The base for relative links is the full current address, not the origin.
   *
   * Pagination on catalogs often looks like href="?page=2". Resolved against the
   * origin, such a link used to expand to "https://clutch.co/?page=2", i.e. the
   * home page instead of the next listing page, and the walk broke on the very
   * first navigation.
   */
  const absolute = (path) => {
    if (!path) return null;
    try {
      return new URL(path, window.location.href).href;
    } catch {
      return null;
    }
  };

  // Team size is easy to confuse with a budget ("$10,000+"), so a number with a dollar sign is not counted.
  const SIZE = /(?<![$\d])\b\d{1,3}(?:,\d{3})?\s*(?:[-\u2013\u2014]|to)\s*\d{1,3}(?:,\d{3})?\b(?!\s*\/?\s*hr)|(?<![$\d])\b\d{1,3},?\d{0,3}\+\s*(?:employees|people|staff|специалист|спеціаліст)/i;
  const RATE = /\$\s?\d+\s*(?:[-\u2013\u2014]|to)\s*\$?\d+\s*\/?\s*hr/i;
  const MIN_PROJECT = /\$\s?[\d,]+\+/;

  /*
   * Reputation in a catalog card. First the schema.org microdata: Clutch, GoodFirms,
   * and TheManifest provide it, and it does not break when the markup changes. Then
   * plain text, because DesignRush and Sortlist do not add the markup.
   */
  const REVIEWS = /(\d[\d,]*)\s*(?:reviews?|відгук\w*|отзыв\w*)/i;
  const RATING_TEXT = /\b([0-5](?:[.,]\d)?)\s*(?:\/\s*5|out of 5|stars?|зірок)/i;
  const FOUNDED = /(?:founded|established|since|засновано|заснована)\D{0,12}(19\d{2}|20\d{2})/i;

  function numberFrom(value) {
    if (!value) return null;
    const parsed = Number(String(value).replace(/[\s,]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function ratingFrom(card, cardText) {
    const meta = card.querySelector('[itemprop="ratingValue"]');
    const fromMeta = numberFrom(meta?.getAttribute('content') || meta?.textContent);
    if (fromMeta !== null && fromMeta >= 0 && fromMeta <= 5) return fromMeta;

    const node = text(card, ['[class*="rating__number" i]', '[class*="rating-number" i]', '[class*="score" i]']);
    const fromNode = numberFrom((node || '').replace(',', '.'));
    if (fromNode !== null && fromNode > 0 && fromNode <= 5) return fromNode;

    const match = RATING_TEXT.exec(cardText);
    return match ? numberFrom(match[1].replace(',', '.')) : null;
  }

  function reviewsFrom(card, cardText) {
    const meta = card.querySelector('[itemprop="reviewCount"], [itemprop="ratingCount"]');
    const fromMeta = numberFrom(meta?.getAttribute('content') || meta?.textContent);
    if (fromMeta !== null) return fromMeta;

    const match = REVIEWS.exec(cardText);
    return match ? numberFrom(match[1]) : null;
  }

  /**
   * The "Other" block: everything the catalog showed beyond the known fields.
   *
   * Two sources feed it. The first is labeled elements: a tooltip or aria-label gives
   * the label, the element's text gives the value ("Min. project size" plus
   * "$10,000+"). The second is "Label: value" pairs in the card's text. Known labels
   * are skipped, because they already have their own columns, and the rest lands here
   * without touching the code for every new catalog.
   */
  const KNOWN_LABEL = /(min\.? project|hourly rate|employees|location|company size|team size)/i;
  /*
   * Button and link labels are not data. Without this filter, "Other" filled up with
   * "See X Reviews", "Show more about provider", and service counters from chart
   * tooltips, i.e. the block became unreadable exactly where it was meant to help.
   */
  const LABEL_NOISE = /^(see|show|view|open|close|read|visit|hide|more|less|next|prev|\d+%)\b/i;
  const VALUE_NOISE = /^(\+\d+\s*services?|show more|read more|\d[\d,]*\s*(reviews?|відгук\w*))$/i;
  const EXTRA_NOISE = /(cookie|privacy|sponsored|advertis)/i;

  function extraFrom(card) {
    const extra = {};

    const put = (label, value) => {
      const key = clean(label).replace(/[:\s]+$/, '');
      const text = clean(value);
      if (!key || !text || key.length > 40 || text.length > 120) return;
      if (key.toLowerCase() === text.toLowerCase()) return;
      if (KNOWN_LABEL.test(key) || LABEL_NOISE.test(key) || EXTRA_NOISE.test(key)) return;
      if (VALUE_NOISE.test(text) || EXTRA_NOISE.test(text)) return;
      if (Object.keys(extra).length >= 12 || extra[key]) return;
      extra[key] = text;
    };

    /*
     * Only labeled elements: the catalog's tooltip and definition lists. `aria-label`
     * is deliberately not read, because it labels buttons, not card fields.
     */
    for (const node of card.querySelectorAll('[data-tooltip-content], dt')) {
      const label = clean(
        (node.getAttribute?.('data-tooltip-content') || node.textContent || '').replace(/<[^>]*>/g, ' '),
      );
      const value =
        node.tagName === 'DT' ? clean(node.nextElementSibling?.textContent) : clean(node.textContent);
      put(label, value);
    }

    for (const match of clean(card.textContent).matchAll(/([A-ZА-ЯІЇЄҐ][\w .'-]{2,28}):\s*([^:•|]{2,60}?)(?=\s{2,}|$|[•|])/g)) {
      put(match[1], match[2]);
    }

    // A verified profile badge is a separate signal: such studios reply more often.
    if (/\bverified\b/i.test(clean(card.querySelector('[class*="verif" i]')?.textContent))) {
      extra['Verified profile'] = 'yes';
    }

    return extra;
  }

  /*
   * Catalogs mix chart labels, ratings, and buttons into the same nodes. They get in
   * the way of the tag filter and carry no weight in scoring, so they are filtered
   * out here instead of landing in the database. The same list is duplicated in
   * backfill-catalog.ts for companies already collected.
   */
  const TAG_NOISE = /(allocation|expertise by|read more|see profile|\+\d+\s*service|^\d+%$|view profile|visit website|was this helpful|^service focus|^\d+(?:\.\d+)?\/\d+\b|reviews? mention|^\d[\d,]*\s*reviews?$|^(see|show|read|view)\b|\d+%)/i;

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

      // A key without spaces and invisible characters: otherwise "Mobile App Development"
      // and the same tag with a non-breaking space would count as different.
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
    // An explicit element with the headcount is more reliable than a regex over the whole card text.
    const sizeNode = text(card, [
      '.employees-count',
      '[class*="employee" i]',
      '[class*="team-size" i]',
      '[class*="company-size" i]',
    ]);

    const founded = FOUNDED.exec(cardText);

    return {
      sizeHint: (sizeNode && (sizeNode.match(SIZE) || [])[0]) || (cardText.match(SIZE) || [])[0] || null,
      rate: (cardText.match(RATE) || [])[0] || null,
      minProject: (cardText.match(MIN_PROJECT) || [])[0] || null,
      rating: ratingFrom(card, cardText),
      reviewsCount: reviewsFrom(card, cardText),
      foundedYear: founded ? Number(founded[1]) : null,
      extra: extraFrom(card),
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

  /** Description of one catalog: how to find its cards, name, website, and profile. */
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
  ];

  /** Next page: the site's own description first, then generic pagination markers. */
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

  /** Generic selectors for the case of an unfamiliar catalog. */
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
          // Rate and minimum project are no longer tags: they have their own fields,
          // and in tags they only cluttered the service filter.
          tags: tagsFrom(card),
          description: base.description,
          sourceUrl: absolute(profile),
          rating: base.rating,
          reviewsCount: base.reviewsCount,
          minProject: base.minProject,
          hourlyRate: base.rate,
          foundedYear: base.foundedYear,
          extra: base.extra,
        };
      })
      .filter(Boolean);
  }

  /** Fallback path: ItemList in JSON-LD. Gives names and profiles, a domain less often. */
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

        const aggregate = org.aggregateRating ?? {};

        items.push({
          name: clean(org.name),
          domain: domainFrom(Array.isArray(org.sameAs) ? org.sameAs[0] : org.sameAs || org.url),
          city: org.address?.addressLocality ?? null,
          country: org.address?.addressCountry ?? null,
          sizeHint: org.numberOfEmployees?.value ? String(org.numberOfEmployees.value) : null,
          tags: [],
          description: clean(org.description) || null,
          sourceUrl: org.url ?? null,
          rating: numberFrom(aggregate.ratingValue),
          reviewsCount: numberFrom(aggregate.reviewCount ?? aggregate.ratingCount),
          minProject: null,
          hourlyRate: clean(org.priceRange) || null,
          foundedYear: numberFrom(String(org.foundingDate ?? '').slice(0, 4)),
          extra: {},
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
