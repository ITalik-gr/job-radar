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
  it('recognizes greenhouse, lever and ashby along with the slug', () => {
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

  it('recognizes workable, recruitee and personio', () => {
    expect(detectAts('https://acme.workable.com/jobs')!.kind).toBe('workable');
    expect(detectAts('https://acme.recruitee.com/')!.kind).toBe('recruitee');
    expect(detectAts('https://acme.jobs.personio.de/')!.kind).toBe('personio');
  });

  it('invents nothing when there is no ATS', () => {
    expect(detectAts('<html><body>About us</body></html>')).toBeNull();
  });
});

describe('detectTech', () => {
  it('recognizes the framework from traces in the HTML', () => {
    expect(detectTech('<script src="/_next/static/chunk.js">')).toContain('next.js');
    expect(detectTech('<div id="__nuxt"></div><script src="/_nuxt/app.js">')).toContain('nuxt');
    expect(detectTech('<link href="/wp-content/themes/x/style.css">')).toContain('wordpress');
    expect(detectTech('<astro-island data-astro-cid="x">')).toContain('astro');
  });

  it('empty HTML gives no hints', () => {
    expect(detectTech('<html><body>hello</body></html>')).toEqual([]);
  });
});

describe('findCareerLinks', () => {
  it('finds links both by href and by text', () => {
    // "Вакансії" (vacancies) is kept in Ukrainian: it exercises the CAREER_TEXT regex,
    // which specifically matches Ukrainian career words on Ukrainian sites.
    const html = `
      <header><a href="/about">About us</a><a href="/careers">Careers</a></header>
      <footer><a href="/team-page">Вакансії</a><a href="https://acme.com/jobs">Jobs</a></footer>`;
    const links = findCareerLinks(html, 'https://acme.com');

    expect(links).toContain('https://acme.com/careers');
    expect(links).toContain('https://acme.com/team-page');
    expect(links).toContain('https://acme.com/jobs');
    expect(links.some((link) => link.includes('/about'))).toBe(false);
  });

  it('ignores junk href values', () => {
    expect(findCareerLinks('<a href="mailto:jobs@acme.com">Jobs</a>', 'https://acme.com')).toEqual([]);
    expect(findCareerLinks('<a href="">Careers</a>', 'https://acme.com')).toEqual([]);
  });
});

describe('looksLikeCareersPage', () => {
  it('a page with a list of vacancies qualifies', () => {
    const html = `<ul>
      <li><a href="/jobs/frontend">Frontend Engineer</a></li>
      <li><a href="/jobs/backend">Backend Engineer</a></li>
    </ul>`;
    expect(looksLikeCareersPage(html)).toBe(true);
  });

  it('an honest "no vacancies" also counts as a careers page', () => {
    expect(looksLikeCareersPage('<p>No open positions right now</p>')).toBe(true);
    expect(looksLikeCareersPage('<p>Наразі немає відкритих вакансій</p>')).toBe(true);
  });

  it('a plain about page does not qualify', () => {
    expect(looksLikeCareersPage('<h1>About us</h1><p>We are a studio from Kyiv</p>')).toBe(false);
  });
});

describe('CAREER_PATHS', () => {
  it('contains the paths from CLAUDE.md in decreasing order of likelihood', () => {
    expect(CAREER_PATHS[0]).toBe('/careers');
    expect(CAREER_PATHS).toContain('/vacancies');
    expect(CAREER_PATHS).toContain('/join-us');
  });
});

describe('protecting a known ATS', () => {
  it('every ATS read through an API is on the untouchable list', () => {
    for (const kind of ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio']) {
      expect(KNOWN_ATS).toContain(kind);
    }
    expect(KNOWN_ATS).not.toContain('html');
  });
});

/*
 * The markup says what the company's own site runs on. The text says what the
 * company builds for clients, and those are different things: a studio that builds
 * headless stores can itself run on WordPress. For a letter the second matters more,
 * so both halves are collected together.
 */
describe('stack from the page text', () => {
  const page = `
    <html><head><script src="/wp-content/themes/main.js"></script></head>
    <body>
      <h1>Services</h1>
      <p>We build headless commerce on Shopify Plus with Sanity as the CMS.</p>
      <p>Front-end in Next.js and TypeScript, payments through Stripe.</p>
    </body></html>
  `;

  it('the markup gives the engine of the site itself', () => {
    expect(detectTech(page)).toContain('wordpress');
  });

  it('the text gives what the company says about itself in words', () => {
    const found = detectTechFromText(page);
    expect(found).toEqual(expect.arrayContaining(['headless cms', 'shopify', 'sanity', 'next.js', 'stripe']));
  });

  it('together they form one set without duplicates', () => {
    const stack = detectStack(page);
    expect(stack).toContain('wordpress');
    expect(stack).toContain('sanity');
    expect(new Set(stack).size).toBe(stack.length);
  });

  it('a name inside another word does not count', () => {
    expect(detectTechFromText('<body>Our process is reactive and proactive.</body>')).not.toContain('react');
  });

  it('the markup is not confused with the text: a word in a class does not make a stack entry', () => {
    // Here "sanity" only appears in the paragraph text, not in a CDN address, and it's the text pass that catches it.
    expect(detectTech('<body><p>sanity checks</p></body>')).not.toContain('sanity');
  });
});
