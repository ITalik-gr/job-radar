import { describe, expect, it } from 'vitest';
import { isoWeek, normalizeDomain, normalizeUrl, slugify } from '../src/lib/normalize.js';

describe('normalizeDomain', () => {
  it('strips the protocol, www and path', () => {
    expect(normalizeDomain('https://www.Example.com/careers')).toBe('example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(normalizeDomain('  HTTP://sub.example.co.uk  ')).toBe('sub.example.co.uk');
  });

  it('returns null for garbage', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('strips utm, ref, gh_src and the hash', () => {
    expect(normalizeUrl('https://example.com/jobs/1?utm_source=x&gh_src=y&id=7#top')).toBe(
      'https://example.com/jobs/1?id=7',
    );
  });

  it('strips the trailing slash and www', () => {
    expect(normalizeUrl('https://www.example.com/careers/')).toBe('https://example.com/careers');
  });
});

describe('slugify', () => {
  it('latinizes Cyrillic and collapses separators', () => {
    expect(slugify('Senior Frontend Developer')).toBe('senior-frontend-developer');
    expect(slugify('Розробник React / Next.js')).toBe('rozrobnyk-react-next-js');
  });
});

describe('isoWeek', () => {
  it('computes the week per ISO', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2026-09-03T00:00:00Z'))).toBe('2026-W36');
  });
});
