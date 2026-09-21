import { describe, expect, it } from 'vitest';
import { scoreCompany } from '../src/pipeline/company-score.js';
import type { Company } from '../src/db/schema.js';

const NOW = Date.parse('2026-09-04T00:00:00Z');

const base = {
  id: 1,
  name: 'Acme Studio',
  domain: 'acme.com',
  country: null,
  city: null,
  sizeHint: null,
  kind: 'studio',
  sources: ['clutch'],
  careersUrl: null,
  careersKind: 'unknown',
  careersSlug: null,
  techHints: [],
  tags: [],
  description: null,
  sourceUrl: null,
  copyrightYear: null,
  lastPostAt: null,
  rating: null,
  reviewsCount: null,
  minProject: null,
  hourlyRate: null,
  foundedYear: null,
  extra: {},
  firstSeen: 0,
  lastChecked: null,
  lastChangeAt: null,
} as unknown as Company;

const score = (patch: Partial<Company>) =>
  scoreCompany({ company: { ...base, ...patch } as Company, now: NOW });

describe('dead site penalty', () => {
  it('an old copyright lowers the company', () => {
    // The idea from STATUS.md: an agency with a 2019 copyright is not hiring.
    const fresh = score({ copyrightYear: 2026 }).score;
    const dead = score({ copyrightYear: 2019 }).score;

    expect(dead).toBeLessThan(fresh);
  });

  it("last year's copyright is not a dead site yet", () => {
    // Sites often update the footer year late, so the threshold is more than one year.
    expect(score({ copyrightYear: 2025 }).score).toBe(score({ copyrightYear: 2026 }).score);
  });

  it('the penalty reason shows in the breakdown, not only in the number', () => {
    const reasons = score({ copyrightYear: 2019 }).negatives.map((item) => item.reason);
    expect(reasons.some((reason) => reason.includes('copyright'))).toBe(true);
  });

  it('a long dead blog lowers it too', () => {
    const recent = score({ lastPostAt: NOW - 30 * 86_400_000 }).score;
    const silent = score({ lastPostAt: NOW - 900 * 86_400_000 }).score;

    expect(silent).toBeLessThan(recent);
  });

  it('without collected signs there is no penalty: no guessing', () => {
    // The signs appear only after enrichment has crawled the site.
    const unknown = score({});
    expect(unknown.negatives.some((item) => /copyright|no posts/.test(item.reason))).toBe(false);
  });

  it('both signs together give both penalties', () => {
    const both = score({ copyrightYear: 2018, lastPostAt: NOW - 1000 * 86_400_000 });
    expect(both.negatives.length).toBeGreaterThanOrEqual(2);
  });
});

describe('catalog reputation', () => {
  it('a high rating and many reviews lift the company', () => {
    const plain = score({}).score;
    const strong = score({ rating: 4.9, reviewsCount: 21 }).score;
    expect(strong).toBeGreaterThan(plain);
  });

  it('an empty profile without a single review gets a minus', () => {
    // Zero reviews is not the same as missing data: the first means an abandoned profile.
    expect(score({ reviewsCount: 0 }).score).toBeLessThan(score({ reviewsCount: null }).score);
  });

  it('a low rating lowers the score, and the reason shows in the breakdown', () => {
    const weak = score({ rating: 3.2 });
    expect(weak.score).toBeLessThan(score({ rating: null }).score);
    expect(weak.negatives.some((item) => item.reason.includes('3.2'))).toBe(true);
  });

  it('the rate is read both from the column and from old tags', () => {
    const fromColumn = score({ hourlyRate: '$50 - $99 / hr' }).score;
    const fromTags = score({ tags: ['$50 - $99 / hr'] }).score;
    expect(fromColumn).toBe(fromTags);
    expect(fromColumn).toBeGreaterThan(score({}).score);
  });
});
