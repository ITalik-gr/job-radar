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

describe('штраф за мертвий сайт', () => {
  it('старий копірайт опускає компанію', () => {
    // Ідея власника зі STATUS.md: агенція з копірайтом 2019 року не наймає.
    const fresh = score({ copyrightYear: 2026 }).score;
    const dead = score({ copyrightYear: 2019 }).score;

    expect(dead).toBeLessThan(fresh);
  });

  it('копірайт минулого року це ще не мертвий сайт', () => {
    // Сайти часто оновлюють рік у футері із запізненням, тому поріг не один рік.
    expect(score({ copyrightYear: 2025 }).score).toBe(score({ copyrightYear: 2026 }).score);
  });

  it('причина штрафу видно в розборі, а не тільки в числі', () => {
    const reasons = score({ copyrightYear: 2019 }).negatives.map((item) => item.reason);
    expect(reasons.some((reason) => reason.includes('копірайт'))).toBe(true);
  });

  it('давно мертвий блог теж опускає', () => {
    const recent = score({ lastPostAt: NOW - 30 * 86_400_000 }).score;
    const silent = score({ lastPostAt: NOW - 900 * 86_400_000 }).score;

    expect(silent).toBeLessThan(recent);
  });

  it('без зібраних ознак штрафу немає: не вгадуємо', () => {
    // Ознаки зʼявляються тільки після проходу enrichment по сайту.
    const unknown = score({});
    expect(unknown.negatives.some((item) => /копірайт|публікац/.test(item.reason))).toBe(false);
  });

  it('обидві ознаки разом дають обидва штрафи', () => {
    const both = score({ copyrightYear: 2018, lastPostAt: NOW - 1000 * 86_400_000 });
    expect(both.negatives.length).toBeGreaterThanOrEqual(2);
  });
});

describe('репутація в каталозі', () => {
  it('висока оцінка і багато відгуків піднімають компанію', () => {
    const plain = score({}).score;
    const strong = score({ rating: 4.9, reviewsCount: 21 }).score;
    expect(strong).toBeGreaterThan(plain);
  });

  it('порожня картка без жодного відгуку отримує мінус', () => {
    // Нуль відгуків це не те саме, що відсутність даних: перше означає покинуту картку.
    expect(score({ reviewsCount: 0 }).score).toBeLessThan(score({ reviewsCount: null }).score);
  });

  it('низька оцінка опускає, і причина видно в розборі', () => {
    const weak = score({ rating: 3.2 });
    expect(weak.score).toBeLessThan(score({ rating: null }).score);
    expect(weak.negatives.some((item) => item.reason.includes('3.2'))).toBe(true);
  });

  it('ставка читається і з колонки, і зі старих тегів', () => {
    const fromColumn = score({ hourlyRate: '$50 - $99 / hr' }).score;
    const fromTags = score({ tags: ['$50 - $99 / hr'] }).score;
    expect(fromColumn).toBe(fromTags);
    expect(fromColumn).toBeGreaterThan(score({}).score);
  });
});
