/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://studio.example.com/" }
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Smoke test for the rendered-page reader, rule 2 in CLAUDE.md.
 *
 * This script is injected into a background tab and sees an already rendered DOM, so it
 * has to be checked the same way: load a real page into jsdom and see what it pulled out
 * of it. Without this test a change to it would break collection silently, and it would
 * look like "the site has nothing", with the owner going in to type in the email by hand.
 */
declare const document: { open(): void; write(html: string): void; close(): void };

interface SiteResult {
  domain: string;
  emails: { email: string; name: string | null; role: string | null; generic: boolean }[];
  techHints: string[];
  copyrightYear: number | null;
  lastPostAt: number | null;
  textLength: number;
  lines: string[];
  links: string[];
}

function readSite(html: string): SiteResult {
  document.open();
  document.write(html);
  document.close();

  // The file's last expression is the result that chrome.scripting picks up.
  // eslint-disable-next-line no-eval
  return (0, eval)(readFileSync('extension/site.js', 'utf8')) as SiteResult;
}

const page = `
  <html><head><script src="/_next/static/chunk.js"></script></head>
  <body>
    <h1>Studio</h1>
    <p>We build headless commerce on Shopify Plus with Sanity and Next.js.</p>
    <a href="mailto:hello@studio.example.com">Write to us</a>
    <p>Anna Koval, CTO: <a href="mailto:anna@studio.example.com">anna@studio.example.com</a></p>
    <nav>
      <a href="/about-us">About us</a>
      <a href="/careers?utm_source=nav">Careers</a>
      <a href="/contact">Contact</a>
      <a href="/portfolio">Work</a>
      <a href="https://dribbble.com/studio/about">Dribbble</a>
    </nav>
    <footer>© 2026 Studio. Last post 2026-08-14.</footer>
  </body></html>
`;

describe('rendered page reader', () => {
  const result = readSite(page);

  it('takes emails from links and from text', () => {
    expect(result.emails.map((item) => item.email)).toEqual(
      expect.arrayContaining(['hello@studio.example.com', 'anna@studio.example.com']),
    );
  });

  /*
   * A named address is worth more than hello@: a person reads it, not a manager at a
   * shared mailbox. The order here decides who the server records as the first contact.
   */
  it('a named address comes ahead of a generic one', () => {
    expect(result.emails[0]?.email).toBe('anna@studio.example.com');
    expect(result.emails.find((item) => item.email.startsWith('hello@'))?.generic).toBe(true);
  });

  it('takes the stack from both the text and the markup', () => {
    expect(result.techHints).toEqual(
      expect.arrayContaining(['headless cms', 'shopify', 'sanity', 'next.js']),
    );
  });

  it('takes liveness signs and the domain without www', () => {
    expect(result.copyrightYear).toBe(2026);
    expect(result.lastPostAt).toBe(Date.parse('2026-08-14'));
    expect(result.domain).toBe('studio.example.com');
  });

  it('an empty page invents nothing', () => {
    const empty = readSite('<html><body><div id="root"></div></body></html>');
    expect(empty.emails).toEqual([]);
    expect(empty.techHints).toEqual([]);
    expect(empty.copyrightYear).toBeNull();
    expect(empty.links).toEqual([]);
  });

  /*
   * Rows are parsed by the server with the same code it uses for pages it fetched itself.
   * So a tag boundary has to break a row the same way `toLines` does: a name and a role
   * must stay on adjacent rows, not merge into one.
   */
  it('returns text as rows split at tag boundaries', () => {
    expect(result.lines).toEqual(expect.arrayContaining(['Studio', 'Anna Koval, CTO:']));
    expect(result.lines.some((line) => line.includes('<'))).toBe(false);
  });

  /*
   * Where to go next. Contacts first, since that's where the email is, then "about us",
   * then vacancies. It was exactly the absence of this step that made a crawl come back
   * with zero: the studio's homepage is a presentation, and the addresses sit on nearby pages.
   */
  it('gives links to follow in order of value, without foreign domains', () => {
    expect(result.links).toEqual([
      'https://studio.example.com/contact',
      'https://studio.example.com/about-us',
      'https://studio.example.com/careers',
    ]);
  });
});
