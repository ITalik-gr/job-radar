/**
 * Читає намальовану сторінку компанії: пошта, стек, ознаки живості, посилання далі.
 *
 * Виконується через chrome.scripting у фоновій вкладці, тобто вже після того, як
 * сайт домалював себе скриптом. Саме тому тут немає нічого про React або SPA:
 * до цього коду доходить звичайний DOM, у якому все на місці.
 *
 * Читається не одна сторінка, а обхід: головна майже ніколи не має ні пошти, ні
 * імен, вони лежать на "контактах", "про нас" і "вакансіях". Сам обхід веде фон,
 * а цей файл каже йому, куди йти далі, списком `links`.
 *
 * Розбір імен і посад тут НЕ робиться навмисно. Він уже написаний на сервері,
 * перевірений тестами і працює по рядках тексту, тому сюди він не переписується:
 * замість цього назовні йде `lines`, той самий плаский текст сторінки, і сервер
 * розбирає його тим самим кодом, що й сторінки, які відкрив сам.
 *
 * Файл самодостатній навмисно: у вкладку він інжектиться окремо, і нічого з
 * решти розширення там немає. Останній вираз це результат, який забирає фон.
 */
(() => {
  const GENERIC =
    /^(hello|info|contact|office|sales|hi|team|mail|admin|support|inquiries|enquiries|hr|jobs|career|careers|welcome|business|marketing|pr|press)@/i;

  const EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

  /** Ті самі маркери, що на сервері. Тут вони по видимому тексту і по розмітці. */
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

  /** Сліди рушія в самій сторінці, а не в тексті про послуги. */
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

  /** Cloudflare ховає адресу за XOR: перший байт це ключ. */
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
   * innerText це саме видимий текст, з урахуванням прихованих блоків, і в браузері
   * він точніший. Але є не скрізь (у jsdom, наприклад, немає), тому запасний варіант
   * це textContent: краще трохи зайвого тексту, ніж порожнеча і мовчазний нуль.
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
   * Плаский текст сторінки по рядках. Рядок це один текстовий вузол, тобто межа
   * будь-якого тега розриває рядок, і саме так само ріже HTML серверний `toLines`.
   * Збіг тут не косметичний: сервер розбирає цей масив тим самим кодом, яким
   * розбирає сторінки, які завантажив сам, і "Anna Koval" поруч з "CTO" у сусідніх
   * рядках це те, за що він чіпляє імена.
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
   * Куди йти далі. Пошта і люди майже ніколи не лежать на головній: на ній стоїть
   * презентація, а адреси на "контактах", імена на "про нас" і на "команді", а
   * career-сторінка каже, чи вони взагалі наймають.
   *
   * Вага задає порядок обходу, бо сторінок за прохід береться лише кілька: спершу
   * контакти, потім команда, потім вакансії. Чужий домен відкидається: посилання
   * "contact" часто веде на форму в чужому сервісі, і ходити туди нема за чим.
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
    // Іменні адреси цінніші за hello@, тому вони першими: сервер бере їх у тому ж порядку.
    emails: [...emails.values()].sort((a, b) => Number(a.generic) - Number(b.generic)).slice(0, 12),
    techHints: [...stack],
    copyrightYear: years.length ? Math.max(...years) : null,
    lastPostAt: dates.length ? Math.max(...dates) : null,
    textLength: text.length,
    lines: lines(),
    links: links(),
  };
})();
