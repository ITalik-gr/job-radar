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

  it('парсить збережену сторінку каталогу', () => {
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.source).toBe('clutch');
      expect(item.name.length).toBeGreaterThan(1);
    }
  });

  it('дістає домен з редиректу r.clutch.co, а не сам редирект', () => {
    expect(
      extractDomain(
        'https://r.clutch.co/redirect?event_category=visit_website&u=https%3A%2F%2Fimaginovation.net%2Fweb-app-development%2F%3Futm_source%3Dclutch.co',
      ),
    ).toBe('imaginovation.net');
    expect(items[0]!.domain).toBe('imaginovation.net');
  });

  it('не приймає посилання на профіль Clutch за домен компанії', () => {
    expect(extractDomain('https://clutch.co/profile/imaginovation')).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
  });

  it('бере розмір, локацію і теги послуг', () => {
    const first = items[0]!;
    expect(first.sizeHint).toBe('10 - 49');
    expect(first.country).toBe('US');
    expect(first.city).toBe('Raleigh');
    expect(first.tags).toContain('$50 - $99 / hr');
    expect(first.tags.some((tag) => /Web Development/i.test(tag))).toBe(true);
  });

  it('порожня сторінка це порожній масив, а не виняток', () => {
    expect(parseClutch('<html><body>Just a moment...</body></html>')).toEqual([]);
  });
});

describe('dou', () => {
  const items = parseList(fixture('dou/companies-list.html'), ['Tech Product']);

  it('парсить перелік компаній', () => {
    expect(items).toHaveLength(4);
    expect(items[0]!.name).toBe('EVOPLAY');
    expect(items[0]!.city).toBe('Київ');
    expect(items[0]!.profileUrl).toContain('jobs.dou.ua/companies/evoplay');
    expect(items[0]!.country).toBe('UA');
  });

  it('переносить теги фільтра і кількість вакансій', () => {
    expect(items[0]!.tags).toEqual(['Tech Product']);
    expect(items[0]!.openVacancies).toBe(45);
  });

  it('домен у переліку відсутній, він тільки на сторінці компанії', () => {
    expect(items.every((item) => item.domain === null)).toBe(true);
  });

  it('парсить сторінку компанії: домен, розмір, місто', () => {
    const profile = parseProfile(fixture('dou/company-profile.html'));
    expect(profile.domain).toBe('evoplay.com.ua');
    expect(profile.sizeHint).toMatch(/1500/);
    expect(profile.city).toBe('Київ');
  });

  it('розуміє всі три формати розміру, якими пише DOU', () => {
    const size = (text: string) =>
      parseProfile(`<div class="b-company-head"><h1>X</h1> <span>${text}</span> <div class="site"><a href="https://x.com">x.com</a></div></div>`)
        .sizeHint;

    expect(size('200...800 спеціалістів')).toBe('200...800 спеціалістів');
    expect(size('понад 1500 спеціалістів')).toBe('понад 1500 спеціалістів');
    expect(size('51-200 співробітників')).toBe('51-200 співробітників');
    expect(size('без згадки про розмір')).toBeNull();
  });

  it('посилання на сторінку вакансій одразу стає careers_url', () => {
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

  it('місто це перше з переліку офісів, без хвоста "офіс"', () => {
    const profile = parseProfile(
      '<div class="b-company-head"><div class="offices">Київ, Варшава (Польща)</div></div>',
    );
    expect(profile.city).toBe('Київ');
  });

  it('фільтри складаються в URL каталогу', () => {
    expect(listUrl({ business: 'Tech Product' })).toBe(
      'https://jobs.dou.ua/companies/?business=Tech+Product',
    );
    expect(listUrl()).toBe('https://jobs.dou.ua/companies/');
  });
});

describe('saveCompanies', () => {
  it('записує компанії з доменом і зливає повторні за доменом', async () => {
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

  it('компанія без домену не пишеться, а потрапляє у skipped', async () => {
    const stats = await saveCompanies(
      [
        {
          source: 'dou',
          name: 'Без сайту',
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
    expect(stats.skipped[0]!.reason).toBe('немає домену');
  });

  it('теги з різних каталогів накопичуються, не затираються', async () => {
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
