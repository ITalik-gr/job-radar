import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYc, sizeBucket, splitLocation } from '../src/sources/catalogs/yc.js';

/** Фікстура це шість справжніх карток зі зрізу hiring, без жодних правок. */
const payload = readFileSync('fixtures/yc/hiring.json', 'utf8');

describe('каталог YC', () => {
  const companies = parseYc(payload);

  it('розбирає всі картки з сайтом', () => {
    expect(companies.length).toBe(6);
    expect(companies.every((row) => row.domain)).toBe(true);
  });

  it('домен береться з сайту, без протокола і www', () => {
    expect(companies.find((row) => row.name === 'Gusto')?.domain).toBe('gusto.com');
  });

  it('локація розкладається на місто і країну', () => {
    const gusto = companies.find((row) => row.name === 'Gusto');
    expect(gusto).toMatchObject({ city: 'San Francisco', country: 'USA' });
  });

  it('індустрія і теги лягають в теги, бо саме їх читає скоринг компаній', () => {
    const amplitude = companies.find((row) => row.name === 'Amplitude');
    expect(amplitude?.tags).toEqual(expect.arrayContaining(['B2B', 'Developer Tools', 'Analytics']));
  });

  it('розмір команди зводиться до тих самих кошиків, що й в інших каталогах', () => {
    expect(sizeBucket(3)).toBe('1 - 9');
    expect(sizeBucket(58)).toBe('50 - 249');
    expect(sizeBucket(null)).toBeNull();
  });

  it('батч потрапляє в блок Інше, а не в теги', () => {
    const row = companies[0]!;
    expect(row.tags).not.toContain(row.extra?.Батч);
  });

  it('одне слово в локації це країна, а не місто', () => {
    expect(splitLocation('Remote')).toEqual({ city: null, country: 'Remote' });
    expect(splitLocation(null)).toEqual({ city: null, country: null });
  });

  it('зламаний JSON падає з поясненням, а не тихим нулем', () => {
    expect(() => parseYc('не json')).toThrow('не є JSON');
    expect(() => parseYc('{}')).toThrow('масив');
  });
});
