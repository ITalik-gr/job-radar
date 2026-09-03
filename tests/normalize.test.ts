import { describe, expect, it } from 'vitest';
import { isoWeek, normalizeDomain, normalizeUrl, slugify } from '../src/lib/normalize.js';

describe('normalizeDomain', () => {
  it('прибирає протокол, www і шлях', () => {
    expect(normalizeDomain('https://www.Example.com/careers')).toBe('example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(normalizeDomain('  HTTP://sub.example.co.uk  ')).toBe('sub.example.co.uk');
  });

  it('повертає null на сміття', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('не домен')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('прибирає utm, ref, gh_src і хеш', () => {
    expect(normalizeUrl('https://example.com/jobs/1?utm_source=x&gh_src=y&id=7#top')).toBe(
      'https://example.com/jobs/1?id=7',
    );
  });

  it('прибирає кінцевий слеш і www', () => {
    expect(normalizeUrl('https://www.example.com/careers/')).toBe('https://example.com/careers');
  });
});

describe('slugify', () => {
  it('латинізує кирилицю і схлопує розділювачі', () => {
    expect(slugify('Senior Frontend Developer')).toBe('senior-frontend-developer');
    expect(slugify('Розробник React / Next.js')).toBe('rozrobnyk-react-next-js');
  });
});

describe('isoWeek', () => {
  it('рахує тиждень за ISO', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2026-09-03T00:00:00Z'))).toBe('2026-W36');
  });
});
