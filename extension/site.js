/**
 * Reads a company's rendered page: email, stack, liveness markers, links to follow.
 *
 * Runs through chrome.scripting in a background tab, i.e. after the site has already
 * rendered itself with a script. That is exactly why there is nothing here about
 * React or SPAs: by the time this code runs, it sees an ordinary DOM with everything
 * in place.
 *
 * What gets read is not one page but a walk: the home page almost never has email or
 * names, they live on "contact", "about", and "careers". The background page drives
 * the walk itself, and this file tells it where to go next, through the `links` list.
 *
 * Parsing names and titles is NOT done here on purpose. It is already written on the
 * server, covered by tests, and works line by line over text, so it is not rewritten
 * here: instead, `lines` goes out, the same flat page text, and the server parses it
 * with the same code it uses for pages it opened itself.
 *
 * The file is deliberately self-contained: it gets injected into the tab on its own,
 * and nothing else from the rest of the extension is there. The last expression is
 * the result the background page picks up.
 */
(() => {
  const GENERIC =
    /^(hello|info|contact|office|sales|hi|team|mail|admin|support|inquiries|enquiries|hr|jobs|career|careers|welcome|business|marketing|pr|press)@/i;

  const EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

  /** The same markers as on the server. Here they run over visible text and over markup. */
  const TECH = [
    [/\bheadless\b/i, 'headless cms'],
    [/\bjamstack\b/i, 'jamstack'],
    [/\bnext\.?js\b/i, 'next.js'],
    [/\bnuxt\b/i, 'nuxt'],
    [/\bastro\b/i, 'astro'],
    [/\breact\b/i, 'react'],
    [/\bvue(\.js)?\b/i, 'vue'],
    [/\bsvelte(kit)?\b/i, 'svelte'],
    [/\bangular\b/i, 'angular'],
    [/\btypescript\b/i, 'typescript'],
    [/\bnode(\.js)?\b/i, 'node'],
    [/\bnest(\.js)?\b/i, 'nestjs'],
    [/\bgraphql\b/i, 'graphql'],
    [/\bsanity\b/i, 'sanity'],
    [/\bcontentful\b/i, 'contentful'],
    [/\bstrapi\b/i, 'strapi'],
    [/\bstoryblok\b/i, 'storyblok'],
    [/\bprismic\b/i, 'prismic'],
    [/\bhygraph\b|\bgraphcms\b/i, 'hygraph'],
    [/\bdatocms\b/i, 'datocms'],
    [/\bpayload\s?cms\b/i, 'payload'],
    [/\bdirectus\b/i, 'directus'],
    [/\bshopify(\s?plus)?\b/i, 'shopify'],
    [/\bwebflow\b/i, 'webflow'],
    [/\bwordpress\b/i, 'wordpress'],
    [/\bwoocommerce\b/i, 'woocommerce'],
    [/\bmagento\b|\badobe commerce\b/i, 'magento'],
    [/\bstripe\b/i, 'stripe'],
    [/\bsupabase\b/i, 'supabase'],
    [/\bfirebase\b/i, 'firebase'],
    [/\bpostgre(s|sql)\b/i, 'postgresql'],
    [/\bcloudflare\b/i, 'cloudflare'],
    [/\bvercel\b/i, 'vercel'],
    [/\baws\b|\bamazon web services\b/i, 'aws'],
    [/\bopenai\b/i, 'openai'],
    [/\banthropic\b|\bclaude\b/i, 'anthropic'],
    [/\bllm\b|\bai integration/i, 'ai integration'],
  ];

  /** Traces of the engine in the page itself, not in text about services. */
  const MARKUP = [
    [/_next\/|__NEXT_DATA__/i, 'next.js'],
    [/__NUXT__|_nuxt\//i, 'nuxt'],
    [/wp-content|wp-includes/i, 'wordpress'],
    [/data-astro|astro-island/i, 'astro'],
    [/cdn\.shopify/i, 'shopify'],
    [/webflow/i, 'webflow'],
    [/ctfassets\.net/i, 'contentful'],
    [/cdn\.sanity\.io/i, 'sanity'],
    [/framerusercontent/i, 'framer'],
    [/tildacdn/i, 'tilda'],
    [/wixstatic/i, 'wix'],
  ];

  /** Cloudflare hides the address behind XOR: the first byte is the key. */
  function decodeCf(hex) {
    if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out.includes('@') ? out : null;
  }

  function unmask(text) {
    return text
      .replace(/\s*[([{<]?\s*(?:at|＠|собака)\s*[)\]}>]?\s*/gi, '@')
      .replace(/\s*[([{<]?\s*(?:dot|крапка)\s*[)\]}>]?\s*/gi, '.');
  }

  const emails = new Map();

  function add(raw, name, role) {
    const email = String(raw || '').toLowerCase().trim().replace(/^mailto:/, '');
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
    if (/^(example|test|your|name|email|user|domain|sentry|wordpress)@/.test(email)) return;
    if (emails.has(email)) return;
    emails.set(email, { email, name: name || null, role: role || null, generic: GENERIC.test(email) });
  }

  for (const node of document.querySelectorAll('a[href^="mailto:"]')) {
    const value = node.getAttribute('href').slice(7).split('?')[0];
    try {
      add(decodeURIComponent(value));
    } catch {
      add(value);
    }
  }

  for (const node of document.querySelectorAll('[data-cfemail]')) {
    const email = decodeCf(node.getAttribute('data-cfemail'));
    if (email) add(email);
  }

  const html = document.documentElement.innerHTML;
  /*
   * innerText is exactly the visible text, accounting for hidden blocks, and in a
   * browser it is more precise. But it is not available everywhere (jsdom, for
   * instance, does not have it), so the fallback is textContent: a bit of extra text
   * is better than emptiness and a silent zero.
   */
  const body = document.body;
  const raw = (body && (body.innerText || body.textContent)) || '';
  const text = unmask(raw.replace(/\s*\n\s*/g, ' '));

  for (const match of text.matchAll(EMAIL)) add(match[0]);
  for (const match of html.matchAll(EMAIL)) add(match[0]);

  const stack = new Set();
  for (const [pattern, name] of TECH) if (pattern.test(text)) stack.add(name);
  for (const [pattern, name] of MARKUP) if (pattern.test(html)) stack.add(name);

  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/gi)].map((m) => Number(m[1]));
  const dates = [...html.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)]
    .map((m) => Date.parse(`${m[1]}-${m[2]}-${m[3]}`))
    .filter(Number.isFinite);

  /*
   * The page's flat text, line by line. A line is one text node, meaning any tag
   * boundary breaks the line, and that is exactly how the server's `toLines` cuts
   * HTML too. The match here is not cosmetic: the server parses this array with the
   * same code it uses to parse pages it loaded itself, and "Anna Koval" next to "CTO"
   * on adjacent lines is exactly what it latches onto to catch names.
   */
  const LINE_LIMIT = 1500;

  function lines() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node && out.length < LINE_LIMIT; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (/^(script|style|noscript|svg|template)$/i.test(parent.tagName)) continue;
      const line = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (line) out.push(line);
    }

    return out;
  }

  /*
   * Where to go next. Email and people almost never live on the home page: it holds
   * a pitch, while addresses live on "contact", names on "about" and "team", and the
   * careers page says whether they are hiring at all.
   *
   * The weight sets the walk order, because only a few pages get taken per pass:
   * contact first, then team, then careers. A different domain gets dropped: a
   * "contact" link often leads to a form on someone else's service, and there is
   * nothing to go there for.
   */
  const LINK_WEIGHT = [
    [/contacts?(-us)?\b|звяж|контакт/i, 0],
    [/about(-us)?\b|team|people|company|leadership|про-?нас|команда/i, 1],
    [/careers?\b|jobs?\b|vacanc|join-?us|вакансі|ваканси/i, 2],
  ];

  function links() {
    const here = location.href;
    const found = new Map();

    for (const node of document.querySelectorAll('a[href]')) {
      let url;
      try {
        url = new URL(node.getAttribute('href'), here);
      } catch {
        continue;
      }

      if (url.hostname !== location.hostname) continue;
      if (!/^https?:$/.test(url.protocol)) continue;

      url.hash = '';
      url.search = '';
      if (url.href === here.split('#')[0]) continue;

      const label = `${url.pathname} ${(node.textContent || '').slice(0, 80)}`;
      const match = LINK_WEIGHT.find(([pattern]) => pattern.test(label));
      if (!match) continue;

      const weight = match[1];
      const known = found.get(url.href);
      if (known === undefined || weight < known) found.set(url.href, weight);
    }

    return [...found.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
      .map(([url]) => url)
      .slice(0, 8);
  }

  return {
    domain: location.hostname.replace(/^www\./, ''),
    url: location.href,
    // Named addresses are more valuable than hello@, so they come first: the server takes them in the same order.
    emails: [...emails.values()].sort((a, b) => Number(a.generic) - Number(b.generic)).slice(0, 12),
    techHints: [...stack],
    copyrightYear: years.length ? Math.max(...years) : null,
    lastPostAt: dates.length ? Math.max(...dates) : null,
    textLength: text.length,
    lines: lines(),
    links: links(),
  };
})();
