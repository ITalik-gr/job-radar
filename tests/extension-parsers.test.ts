/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://clutch.co/web-developers" }
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Smoke test for the catalog collector. Rule 2 in CLAUDE.md requires a fixture test
 * for every source adapter, and the extension is just such an adapter, it just runs
 * in the owner's browser. Without this test a Clutch layout change would break
 * collection silently: the page opens, zero cards come back, and it looks like an
 * empty catalog.
 *
 * The parser is written as a plain page script, so it runs as is, in jsdom, and
 * reads the same `document` it would in a real tab.
 */

/*
 * DOM types are deliberately not added to the project's tsconfig: the worker and the
 * CLI have no access to `document`, and the global "DOM" lib would let browser code
 * be written there that only crashes in production. So the declarations are local,
 * scoped to this file alone.
 */
declare const document: { open(): void; write(html: string): void; close(): void };
declare const window: unknown;

interface ParsedItem {
  name: string;
  domain: string | null;
  city: string | null;
  country: string | null;
  sizeHint: string | null;
  tags: string[];
  description: string | null;
  sourceUrl: string | null;
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  extra: Record<string, string>;
}

interface Parsers {
  parse(): { site: string; known: boolean; method: string; items: ParsedItem[]; nextPage: string | null };
}

function loadParsers(html: string): Parsers {
  document.open();
  document.write(html);
  document.close();

  // The script attaches itself to window.JobRadarParsers, just like in a real tab.
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync('extension/parsers.js', 'utf8'));
  return (window as unknown as { JobRadarParsers: Parsers }).JobRadarParsers;
}

describe('extension catalog parser', () => {
  let result: ReturnType<Parsers['parse']>;

  beforeAll(() => {
    result = loadParsers(readFileSync('fixtures/clutch/web-developers.html', 'utf8')).parse();
  });

  it('recognizes Clutch and parses the cards, not the JSON-LD fallback', () => {
    expect(result.site).toBe('clutch.co');
    expect(result.known).toBe(true);
    expect(result.method).toBe('cards');
    expect(result.items.length).toBeGreaterThan(0);
  });

  // Rule 3: zero cards on a live page is an error, not an empty catalog.
  it('returns zero on unfamiliar markup, not made-up cards', () => {
    const empty = loadParsers('<html><body><p>Just a moment...</p></body></html>').parse();
    expect(empty.items).toEqual([]);
  });

  it('takes the company name and domain, not a link to the catalog itself', () => {
    const first = result.items[0]!;
    expect(first.name).toBe('Imaginovation');
    expect(first.domain).toBe('imaginovation.net');
    expect(result.items.every((item) => !/clutch\.co/.test(item.domain ?? ''))).toBe(true);
  });

  it('takes the rating, review count, rate and minimum project', () => {
    const first = result.items[0]!;
    expect(first.rating).toBe(4.9);
    expect(first.reviewsCount).toBe(16);
    expect(first.hourlyRate).toBe('$50 - $99 / hr');
    expect(first.minProject).toBe('$10,000+');
    expect(first.sizeHint).toBe('10 - 49');
  });

  it('the rate and minimum project are not duplicated in the service tags', () => {
    const first = result.items[0]!;
    expect(first.tags).not.toContain('$50 - $99 / hr');
    expect(first.tags.some((tag) => /Web Development/i.test(tag))).toBe(true);
  });

  it('the "Other" block does not pull in button labels and service counters', () => {
    for (const item of result.items) {
      for (const [label, value] of Object.entries(item.extra)) {
        // "See X Reviews", "Show more about provider" are button labels, not data.
        expect(label).not.toMatch(/^(see|show|view|read|visit|\d+%)\b/i);
        expect(value).not.toMatch(/^(\+\d+ services?|show more|\d+ reviews?)$/i);
      }
    }
    // A verified profile on Clutch is a genuine signal, it stays.
    expect(result.items[0]!.extra['Verified profile']).toBe('yes');
  });

  it('the "Other" block does not pull in labels that already have their own columns', () => {
    for (const item of result.items) {
      const labels = Object.keys(item.extra).join(' ');
      expect(labels).not.toMatch(/min\.? project|hourly rate|employees|location/i);
      for (const value of Object.values(item.extra)) {
        expect(value.length).toBeGreaterThan(0);
        expect(value.length).toBeLessThanOrEqual(120);
      }
      expect(Object.keys(item.extra).length).toBeLessThanOrEqual(12);
    }
  });

  it('the rating stays within scale, and reviews are a whole number', () => {
    for (const item of result.items) {
      if (item.rating !== null) {
        expect(item.rating).toBeGreaterThan(0);
        expect(item.rating).toBeLessThanOrEqual(5);
      }
      if (item.reviewsCount !== null) expect(Number.isInteger(item.reviewsCount)).toBe(true);
    }
  });
});
