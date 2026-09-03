/**
 * Збирач каталогів. Працює у вкладці, яку ти вже відкрив руками, розбирає видиму
 * сторінку і шле результат у локальний Job Radar. Нічого не обходить: сторінку
 * відкрив браузер, а не скрипт, тому Cloudflare тут ні до чого.
 *
 * Ставиться як закладка: скопіювати вміст dist-рядка з `pnpm cli bookmarklet`
 * і вставити в адресу нової закладки.
 */
(function collect() {
  const API = 'http://localhost:3000/api/import/catalog';

  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  const domainFrom = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const inner = url.searchParams.get('u') || url.searchParams.get('url') || url.searchParams.get('redirect');
      const target = inner ? new URL(inner) : url;
      const host = target.hostname.replace(/^www\./, '').toLowerCase();
      if (host === location.hostname.replace(/^www\./, '')) return null;
      if (/(facebook|twitter|x\.com|linkedin|instagram|youtube|google|schema\.org|w3\.org|gstatic|gravatar)/.test(host)) return null;
      return host.includes('.') ? host : null;
    } catch {
      return null;
    }
  };

  const pickText = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node && clean(node.textContent)) return clean(node.textContent);
    }
    return null;
  };

  const pickHref = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node && node.getAttribute('href')) return node.getAttribute('href');
    }
    return null;
  };

  /** Картки різних каталогів. Порядок від конкретного до загального. */
  const CARD_SELECTORS = [
    'li.provider-list-item',
    '.provider-row',
    '[data-clutch-pid]',
    '.company-card',
    '.agency-card',
    '.profile-card',
    '.directory-item',
    '[itemtype*="LocalBusiness"]',
    '[itemtype*="Organization"]',
    'article[class*="company" i]',
    'div[class*="company-item" i]',
    'li[class*="agency" i]',
  ];

  function fromCards() {
    let cards = [];
    for (const selector of CARD_SELECTORS) {
      const found = [...document.querySelectorAll(selector)];
      if (found.length >= 3) {
        cards = found;
        break;
      }
    }
    if (cards.length === 0) return [];

    return cards
      .map((card) => {
        const name =
          pickText(card, ['h3 a', 'h2 a', 'h3', 'h2', '[itemprop="name"]', 'a[class*="title" i]']) ||
          clean(card.getAttribute('data-title'));

        const websiteHref =
          pickHref(card, [
            'a[class*="website" i]',
            'a[href*="/redirect"]',
            'a[rel="nofollow"][target="_blank"]',
            'a[href^="http"][target="_blank"]',
          ]) || null;

        const profileHref = pickHref(card, [
          'a[href*="/profile/"]',
          'a[href*="/company/"]',
          'a[href*="/companies/"]',
          'a[href*="/agency/"]',
          'h3 a',
          'h2 a',
        ]);

        const text = clean(card.textContent);
        const size = (text.match(/\b\d{1,3}(?:,\d{3})?\s*[-\u2013\u2014]\s*\d{1,3}(?:,\d{3})?\b(?=\s|$)/) || [])[0] ||
          (text.match(/\b\d{1,3},?\d{0,3}\+\b/) || [])[0] || null;
        const rate = (text.match(/\$\s?\d+\s*[-\u2013\u2014]\s*\$?\d+\s*\/?\s*hr/i) || [])[0] || null;
        const minProject = (text.match(/\$\s?[\d,]+\+/) || [])[0] || null;

        const tags = [...card.querySelectorAll('[class*="service" i], [class*="tag" i], [class*="skill" i]')]
          .map((node) => clean(node.getAttribute('data-tooltip-content') || node.textContent))
          .map((tag) => tag.replace(/^\d+%\s*/, '').replace(/<[^>]*>/g, ''))
          .filter((tag) => tag && tag.length < 40)
          .slice(0, 12);

        // Навмисно не `location`: воно затінює window.location, і sourceUrl падає.
        const city =
          pickText(card, ['[itemprop="addressLocality"]', '[class*="location" i]', '[class*="address" i]']) || null;
        const country = card.querySelector('[itemprop="addressCountry"]')?.getAttribute('content') || null;

        return {
          name,
          domain: domainFrom(websiteHref),
          city,
          country,
          sizeHint: size,
          tags: [...new Set([...tags, rate, minProject].filter(Boolean))],
          description: pickText(card, ['[class*="description" i]', 'p']),
          sourceUrl: profileHref ? new URL(profileHref, window.location.origin).href : null,
        };
      })
      .filter((item) => item.name);
  }

  /** Запасний шлях: багато каталогів віддають ItemList у JSON-LD. */
  function fromJsonLd() {
    const items = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue;
      }
      const list = [].concat(data['@graph'] || [], data.itemListElement || [], data);
      for (const entry of list) {
        const org = entry?.item ?? entry;
        if (!org || !['Organization', 'LocalBusiness', 'ProfessionalService'].includes(org['@type'])) continue;
        items.push({
          name: clean(org.name),
          domain: domainFrom(org.sameAs?.[0] || org.url),
          city: org.address?.addressLocality ?? null,
          country: org.address?.addressCountry ?? null,
          sizeHint: null,
          tags: [],
          description: clean(org.description) || null,
          sourceUrl: org.url ?? null,
        });
      }
    }
    return items.filter((item) => item.name);
  }

  const cards = fromCards();
  const items = cards.length > 0 ? cards : fromJsonLd();
  const withDomain = items.filter((item) => item.domain);

  if (items.length === 0) {
    alert('Job Radar: карток на сторінці не знайдено. Скинь мені URL, додам розбір для цього каталогу.');
    return;
  }

  fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: location.hostname.replace(/^www\./, ''), pageUrl: location.href, items }),
  })
    .then((response) => response.json())
    .then((result) => {
      alert(
        `Job Radar: на сторінці ${items.length}, з доменом ${withDomain.length}\n` +
          `нових ${result.itemsNew}, оновлено ${result.updated}, без домену ${result.skipped}`,
      );
    })
    .catch(() => {
      alert('Job Radar: не достукався до localhost:3000. Запусти pnpm start і спробуй ще раз.');
    });
})();
