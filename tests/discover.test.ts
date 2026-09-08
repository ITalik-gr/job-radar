import { describe, expect, it } from 'vitest';
import {
  CAREER_PATHS,
  KNOWN_ATS,
  detectAts,
  detectTech,
  findCareerLinks,
  looksLikeCareersPage,
  detectTechFromText,
  detectStack,
} from '../src/pipeline/discover.js';

describe('detectAts', () => {
  it('впізнає greenhouse, lever і ashby разом зі slug', () => {
    expect(detectAts('<a href="https://boards.greenhouse.io/acme">Jobs</a>')).toEqual({
      kind: 'greenhouse',
      slug: 'acme',
    });
    expect(detectAts('<a href="https://jobs.lever.co/beta-corp/">Jobs</a>')).toEqual({
      kind: 'lever',
      slug: 'beta-corp',
    });
    expect(detectAts('window.location="https://jobs.ashbyhq.com/gamma"')).toEqual({
      kind: 'ashby',
      slug: 'gamma',
    });
  });

  it('впізнає workable, recruitee і personio', () => {
    expect(detectAts('https://acme.workable.com/jobs')!.kind).toBe('workable');
    expect(detectAts('https://acme.recruitee.com/')!.kind).toBe('recruitee');
    expect(detectAts('https://acme.jobs.personio.de/')!.kind).toBe('personio');
  });

  it('нічого не вигадує, коли ATS немає', () => {
    expect(detectAts('<html><body>Про нас</body></html>')).toBeNull();
  });
});

describe('detectTech', () => {
  it('розпізнає фреймворк за слідами в HTML', () => {
    expect(detectTech('<script src="/_next/static/chunk.js">')).toContain('next.js');
    expect(detectTech('<div id="__nuxt"></div><script src="/_nuxt/app.js">')).toContain('nuxt');
    expect(detectTech('<link href="/wp-content/themes/x/style.css">')).toContain('wordpress');
    expect(detectTech('<astro-island data-astro-cid="x">')).toContain('astro');
  });

  it('порожній HTML не дає підказок', () => {
    expect(detectTech('<html><body>привіт</body></html>')).toEqual([]);
  });
});

describe('findCareerLinks', () => {
  it('знаходить посилання і за href, і за текстом', () => {
    const html = `
      <header><a href="/about">Про нас</a><a href="/careers">Careers</a></header>
      <footer><a href="/team-page">Вакансії</a><a href="https://acme.com/jobs">Jobs</a></footer>`;
    const links = findCareerLinks(html, 'https://acme.com');

    expect(links).toContain('https://acme.com/careers');
    expect(links).toContain('https://acme.com/team-page');
    expect(links).toContain('https://acme.com/jobs');
    expect(links.some((link) => link.includes('/about'))).toBe(false);
  });

  it('ігнорує сміттєві href', () => {
    expect(findCareerLinks('<a href="mailto:jobs@acme.com">Jobs</a>', 'https://acme.com')).toEqual([]);
    expect(findCareerLinks('<a href="">Careers</a>', 'https://acme.com')).toEqual([]);
  });
});

describe('looksLikeCareersPage', () => {
  it('сторінка з переліком вакансій підходить', () => {
    const html = `<ul>
      <li><a href="/jobs/frontend">Frontend Engineer</a></li>
      <li><a href="/jobs/backend">Backend Engineer</a></li>
    </ul>`;
    expect(looksLikeCareersPage(html)).toBe(true);
  });

  it('чесне "вакансій немає" теж вважається career-сторінкою', () => {
    expect(looksLikeCareersPage('<p>No open positions right now</p>')).toBe(true);
    expect(looksLikeCareersPage('<p>Наразі немає відкритих вакансій</p>')).toBe(true);
  });

  it('звичайна сторінка про компанію не підходить', () => {
    expect(looksLikeCareersPage('<h1>Про нас</h1><p>Ми студія з Києва</p>')).toBe(false);
  });
});

describe('CAREER_PATHS', () => {
  it('містить шляхи з CLAUDE.md у порядку спадання ймовірності', () => {
    expect(CAREER_PATHS[0]).toBe('/careers');
    expect(CAREER_PATHS).toContain('/vacancies');
    expect(CAREER_PATHS).toContain('/join-us');
  });
});

describe('захист відомого ATS', () => {
  it('усі ATS, які читаються через API, у списку недоторканних', () => {
    for (const kind of ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio']) {
      expect(KNOWN_ATS).toContain(kind);
    }
    expect(KNOWN_ATS).not.toContain('html');
  });
});

/*
 * Розмітка каже, на чому зроблений сайт компанії. Текст каже, що компанія робить
 * клієнтам, і це різні речі: студія, яка робить headless-магазини, сама може сидіти
 * на WordPress. Для листа важливіше друге, тому обидві половини збираються разом.
 */
describe('стек із тексту сторінки', () => {
  const page = `
    <html><head><script src="/wp-content/themes/main.js"></script></head>
    <body>
      <h1>Services</h1>
      <p>We build headless commerce on Shopify Plus with Sanity as the CMS.</p>
      <p>Front-end in Next.js and TypeScript, payments through Stripe.</p>
    </body></html>
  `;

  it('розмітка дає рушій самого сайту', () => {
    expect(detectTech(page)).toContain('wordpress');
  });

  it('текст дає те, про що компанія пише словами', () => {
    const found = detectTechFromText(page);
    expect(found).toEqual(expect.arrayContaining(['headless cms', 'shopify', 'sanity', 'next.js', 'stripe']));
  });

  it('разом це одна множина без повторів', () => {
    const stack = detectStack(page);
    expect(stack).toContain('wordpress');
    expect(stack).toContain('sanity');
    expect(new Set(stack).size).toBe(stack.length);
  });

  it('назва всередині іншого слова не рахується', () => {
    expect(detectTechFromText('<body>Our process is reactive and proactive.</body>')).not.toContain('react');
  });

  it('розмітка не плутається з текстом: слово в класі не робить стек', () => {
    // Тут "sanity" лише в тексті абзацу, а не в адресі CDN, і саме текст його ловить.
    expect(detectTech('<body><p>sanity checks</p></body>')).not.toContain('sanity');
  });
});
