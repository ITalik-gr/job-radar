import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, setRuntimeEnv } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies } from '../src/db/schema.js';
import { readSetting, writeSetting } from '../src/lib/settings-store.js';
import { saveCompanies } from '../src/pipeline/catalogs.js';
import { allQueries, parsePlaces, places, siteDomain } from '../src/sources/catalogs/places.js';

/*
 * The fixture follows the documented Places API (New) Text Search response with made up
 * businesses: there was no key to record a real one. Replace it with a recorded response once the
 * key is set, the assertions below hold for any Lviv dental search.
 */
const payload = readFileSync('fixtures/places/search-text.json', 'utf8');

describe('Places parsing', () => {
  const rows = parsePlaces(payload, { slug: 'dental' });

  it('keeps operating businesses only', () => {
    expect(rows.map((row) => row.name)).toEqual(['Стоматологія Посмішка', 'Дентал Студіо', 'Клініка без сайту']);
  });

  it('a business gets its site, place id, city, country, phone, rating and the query industry', () => {
    expect(rows[0]).toMatchObject({
      domain: 'posmishka-dental.example.ua',
      placeId: 'ChIJfixtureDental0001',
      city: 'Львів',
      country: 'UA',
      phone: '+380320000001',
      rating: 4.8,
      reviewsCount: 214,
      industry: 'dental',
      kind: 'smb',
    });
  });

  it('an Instagram link is a profile, not a site', () => {
    expect(rows[1]!.domain).toBeNull();
    expect(rows[1]!.extra).toEqual({ Profile: 'https://www.instagram.com/dental.studio.example/' });
    expect(siteDomain('https://facebook.com/clinic')).toBeNull();
    expect(siteDomain('https://m.facebook.com/clinic')).toBeNull();
    expect(siteDomain('https://clinic.com.ua')).toBe('clinic.com.ua');
  });

  it('an error response fails loudly', () => {
    expect(() => parsePlaces('{"error":{"message":"API key not valid"}}')).toThrow('API key not valid');
    expect(() => parsePlaces('<html>')).toThrow('not JSON');
  });

  it('every niche in every city is a query', () => {
    expect(allQueries().length).toBeGreaterThanOrEqual(25);
    expect(allQueries()[0]).toMatchObject({ industry: 'dental', city: 'Київ' });
  });
});

describe('Places run', () => {
  const calls: { body: { textQuery: string }; key: string | null }[] = [];

  beforeAll(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
    runMigrations().sqlite.close();
    setRuntimeEnv({ GOOGLE_PLACES_API_KEY: 'test-places-key', PLACES_QUERIES_PER_RUN: '3', PLACES_MONTHLY_LIMIT: '4' });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-goog-api-key') });
      return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    setRuntimeEnv({ GOOGLE_PLACES_API_KEY: '', PLACES_QUERIES_PER_RUN: '', PLACES_MONTHLY_LIMIT: '' });
  });

  it('runs a few queries, sends the key in a header, and moves the cursor', async () => {
    const found = await places.fetch({});
    expect(calls).toHaveLength(3);
    expect(calls[0]!.key).toBe('test-places-key');
    expect(calls[0]!.body.textQuery).toBe('стоматологія Київ');
    expect(found).toHaveLength(9);
    expect(await readSetting('places_cursor', 0)).toBe(3);
  });

  it('stops at the monthly cap', async () => {
    const found = await places.fetch({});
    // 3 calls were used, the cap is 4: one more query, then nothing.
    expect(calls).toHaveLength(1);
    expect(found).toHaveLength(3);
    await expect(places.fetch({})).rejects.toThrow('monthly limit');
    await writeSetting('places_usage', null);
  });

  it('saves businesses with and without a site, once each', async () => {
    const rows = parsePlaces(payload, { slug: 'dental' });
    const first = await saveCompanies(rows, 'places');
    expect(first).toMatchObject({ itemsNew: 3, skipped: [] });
    const again = await saveCompanies(rows, 'places');
    expect(again).toMatchObject({ itemsNew: 0, updated: 3 });

    const [siteless] = await getDb().select().from(companies).where(eq(companies.placeId, 'ChIJfixtureDental0003'));
    expect(siteless).toMatchObject({ domain: '', kind: 'smb', industry: 'dental', market: 'ua', phone: '+380500000003' });
  });

  it('without a key the source says it is off', async () => {
    setRuntimeEnv({ GOOGLE_PLACES_API_KEY: '' });
    await expect(places.fetch({})).rejects.toThrow('GOOGLE_PLACES_API_KEY');
    setRuntimeEnv({ GOOGLE_PLACES_API_KEY: 'test-places-key' });
  });
});
