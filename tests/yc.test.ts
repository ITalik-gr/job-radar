import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYc, sizeBucket, splitLocation } from '../src/sources/catalogs/yc.js';

/** The fixture is six real cards from the hiring slice, unedited. */
const payload = readFileSync('fixtures/yc/hiring.json', 'utf8');

describe('YC catalog', () => {
  const companies = parseYc(payload);

  it('parses every card that has a site', () => {
    expect(companies.length).toBe(6);
    expect(companies.every((row) => row.domain)).toBe(true);
  });

  it('the domain is taken from the site, without protocol and www', () => {
    expect(companies.find((row) => row.name === 'Gusto')?.domain).toBe('gusto.com');
  });

  it('the location splits into city and country', () => {
    const gusto = companies.find((row) => row.name === 'Gusto');
    expect(gusto).toMatchObject({ city: 'San Francisco', country: 'USA' });
  });

  it('industry and tags land in tags, since that is what company scoring reads', () => {
    const amplitude = companies.find((row) => row.name === 'Amplitude');
    expect(amplitude?.tags).toEqual(expect.arrayContaining(['B2B', 'Developer Tools', 'Analytics']));
  });

  it('team size maps to the same buckets as in other catalogs', () => {
    expect(sizeBucket(3)).toBe('1 - 9');
    expect(sizeBucket(58)).toBe('50 - 249');
    expect(sizeBucket(null)).toBeNull();
  });

  it('the batch lands in the Other block, not in tags', () => {
    const row = companies[0]!;
    expect(row.tags).not.toContain(row.extra?.Batch);
  });

  it('a single word in the location is a country, not a city', () => {
    expect(splitLocation('Remote')).toEqual({ city: null, country: 'Remote' });
    expect(splitLocation(null)).toEqual({ city: null, country: null });
  });

  it('broken JSON fails with an explanation, not a silent zero', () => {
    expect(() => parseYc('not json')).toThrow('is not JSON');
    expect(() => parseYc('{}')).toThrow('array');
  });
});
