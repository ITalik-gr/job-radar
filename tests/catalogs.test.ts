import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies } from '../src/db/schema.js';
import { extractDomain, parse as parseClutch } from '../src/sources/catalogs/clutch.js';
import { listUrl, parseList, parseProfile } from '../src/sources/catalogs/dou.js';
import { saveCompanies } from '../src/pipeline/catalogs.js';

const fixture = (path: string) => readFileSync(`fixtures/${path}`, 'utf8');

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

describe('clutch', () => {
  const items = parseClutch(fixture('clutch/web-developers.html'));

  it('parses a saved directory page', () => {
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.source).toBe('clutch');
      expect(item.name.length).toBeGreaterThan(1);
    }
  });

  it('extracts the domain from the r.clutch.co redirect, not the redirect itself', () => {
    expect(
      extractDomain(
        'https://r.clutch.co/redirect?event_category=visit_website&u=https%3A%2F%2Fimaginovation.net%2Fweb-app-development%2F%3Futm_source%3Dclutch.co',
      ),
    ).toBe('imaginovation.net');
    expect(items[0]!.domain).toBe('imaginovation.net');
  });

  it('does not take a Clutch profile link as the company domain', () => {
    expect(extractDomain('https://clutch.co/profile/imaginovation')).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
  });

  it('takes the size, location and service tags', () => {
    const first = items[0]!;
    expect(first.sizeHint).toBe('10 - 49');
    expect(first.country).toBe('US');
    expect(first.city).toBe('Raleigh');
    expect(first.tags.some((tag) => /Web Development/i.test(tag))).toBe(true);
    // The rate and minimum project have their own fields, they no longer belong in tags.
    expect(first.tags).not.toContain('$50 - $99 / hr');
  });

  it('takes the rating, reviews, rate and minimum project as separate fields', () => {
    const first = items[0]!;
    expect(first.rating).toBe(4.9);
    expect(first.reviewsCount).toBe(16);
    expect(first.hourlyRate).toBe('$50 - $99 / hr');
    expect(first.minProject).toBe('$10,000+');
  });

  it('puts everything else from the card into the "Other" block, without labels that already have columns', () => {
    const extra = items[0]!.extra ?? {};
    // Known labels have columns and do not end up here.
    expect(Object.keys(extra).join(' ')).not.toMatch(/min\.? project|employees|location/i);
    for (const [label, value] of Object.entries(extra)) {
      expect(label.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('an empty page is an empty array, not an exception', () => {
    expect(parseClutch('<html><body>Just a moment...</body></html>')).toEqual([]);
  });
});

describe('dou', () => {
  const items = parseList(fixture('dou/companies-list.html'), ['Tech Product']);

  it('parses the company list', () => {
    expect(items).toHaveLength(4);
    expect(items[0]!.name).toBe('EVOPLAY');
    expect(items[0]!.city).toBe('Київ');
    expect(items[0]!.profileUrl).toContain('jobs.dou.ua/companies/evoplay');
    expect(items[0]!.country).toBe('UA');
  });

  it('carries over the filter tags and the open vacancy count', () => {
    expect(items[0]!.tags).toEqual(['Tech Product']);
    expect(items[0]!.openVacancies).toBe(45);
  });

  it('the domain is absent from the list, it only appears on the company page', () => {
    expect(items.every((item) => item.domain === null)).toBe(true);
  });

  it('parses the company page: domain, size, city', () => {
    const profile = parseProfile(fixture('dou/company-profile.html'));
    expect(profile.domain).toBe('evoplay.com.ua');
    expect(profile.sizeHint).toMatch(/1500/);
    expect(profile.city).toBe('Київ');
  });

  it('understands all three size formats that DOU writes', () => {
    const size = (text: string) =>
      parseProfile(`<div class="b-company-head"><h1>X</h1> <span>${text}</span> <div class="site"><a href="https://x.com">x.com</a></div></div>`)
        .sizeHint;

    expect(size('200...800 спеціалістів')).toBe('200...800 спеціалістів');
    expect(size('понад 1500 спеціалістів')).toBe('понад 1500 спеціалістів');
    expect(size('51-200 співробітників')).toBe('51-200 співробітників');
    expect(size('без згадки про розмір')).toBeNull();
  });

  it('a link to the vacancies page immediately becomes careers_url', () => {
    const withCareers = parseProfile(
      '<div class="b-company-head"><div class="site"><a href="https://macpaw.com/careers">macpaw.com/careers</a></div></div>',
    );
    expect(withCareers.domain).toBe('macpaw.com');
    expect(withCareers.careersUrl).toBe('https://macpaw.com/careers');

    const plain = parseProfile(
      '<div class="b-company-head"><div class="site"><a href="http://evoplay.com.ua">evoplay.com.ua</a></div></div>',
    );
    expect(plain.careersUrl).toBeNull();
  });

  it('the city is the first of the listed offices, without an "office" tail', () => {
    const profile = parseProfile(
      '<div class="b-company-head"><div class="offices">Київ, Варшава (Польща)</div></div>',
    );
    expect(profile.city).toBe('Київ');
  });

  it('filters are assembled into the directory URL', () => {
    expect(listUrl({ business: 'Tech Product' })).toBe(
      'https://jobs.dou.ua/companies/?business=Tech+Product',
    );
    expect(listUrl()).toBe('https://jobs.dou.ua/companies/');
  });
});

describe('saveCompanies', () => {
  it('saves companies with a domain and merges repeats by domain', async () => {
    const items = parseClutch(fixture('clutch/web-developers.html'));
    const first = await saveCompanies(items, 'clutch');
    expect(first.itemsNew).toBeGreaterThan(0);

    const second = await saveCompanies(items, 'clutch');
    expect(second.itemsNew).toBe(0);
    expect(second.updated).toBe(first.itemsNew);

    const rows = await getDb().select().from(companies);
    expect(rows.length).toBe(first.itemsNew);
    expect(rows[0]!.tags.length).toBeGreaterThan(0);
  });

  it('a company without a domain is not saved, it goes into skipped instead', async () => {
    const stats = await saveCompanies(
      [
        {
          source: 'dou',
          name: 'No Website',
          domain: null,
          country: 'UA',
          city: 'Київ',
          sizeHint: null,
          careersUrl: null,
          sourceUrl: null,
          tags: [],
          description: null,
          openVacancies: null,
        },
      ],
      'dou',
    );

    expect(stats.itemsNew).toBe(0);
    expect(stats.skipped[0]!.reason).toBe('no domain');
  });

  it('tags from different catalogs accumulate, they are not overwritten', async () => {
    const rows = await getDb().select().from(companies);
    const target = rows[0]!;

    await saveCompanies(
      [
        {
          source: 'dou',
          name: target.name,
          domain: target.domain,
          country: null,
          city: null,
          sizeHint: null,
          careersUrl: null,
          sourceUrl: null,
          tags: ['Tech Product'],
          description: null,
          openVacancies: null,
        },
      ],
      'dou',
    );

    const [updated] = await getDb().select().from(companies).where(eq(companies.id, target.id));
    expect(updated!.tags).toContain('Tech Product');
    expect(updated!.tags.length).toBeGreaterThan(target.tags.length);
    expect(updated!.sources).toEqual(['clutch', 'dou']);
  });
});
