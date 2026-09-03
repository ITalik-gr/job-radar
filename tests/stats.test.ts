import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { lifetimes, median, medianSalaries, perDay, topTech } from '../src/pipeline/stats.js';

const DAY = 86_400_000;
let acme: Company;

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test', country: 'UA' })).company;

  const now = Date.now();
  await getDb().insert(vacancies).values([
    {
      companyId: acme.id,
      source: 'test',
      url: 'https://acme.com/1',
      title: 'Senior Frontend',
      stack: ['react', 'typescript'],
      seniority: 'senior',
      salaryMin: 4000,
      salaryMax: 6000,
      score: 15,
      firstSeen: now - 10 * DAY,
      closedAt: now - 4 * DAY,
      dedupeKey: 'a|1|w',
    },
    {
      companyId: acme.id,
      source: 'test',
      url: 'https://acme.com/2',
      title: 'Middle Frontend',
      stack: ['react', 'next.js'],
      seniority: 'middle',
      salaryMin: 3000,
      score: 12,
      firstSeen: now - 30 * DAY,
      closedAt: now - 10 * DAY,
      dedupeKey: 'a|2|w',
    },
    {
      companyId: acme.id,
      source: 'test',
      url: 'https://acme.com/3',
      title: 'Вічна вакансія',
      stack: ['react'],
      score: 9,
      firstSeen: now - 200 * DAY,
      dedupeKey: 'a|3|w',
    },
    {
      companyId: acme.id,
      source: 'test',
      url: 'https://acme.com/4',
      title: 'Angular Developer',
      stack: ['angular'],
      score: -100,
      firstSeen: now - 2 * DAY,
      dedupeKey: 'a|4|w',
    },
  ]);
});

describe('median', () => {
  it('рахує медіану для парної і непарної кількості', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('topTech', () => {
  it('рахує технології, ігноруючи відсіяні стоп-словами', async () => {
    const rows = await topTech(365);
    expect(rows[0]).toEqual({ tech: 'react', count: 3 });
    expect(rows.some((row) => row.tech === 'angular')).toBe(false);
  });

  it('за короткий період старі вакансії не рахуються', async () => {
    const rows = await topTech(5);
    expect(rows.every((row) => row.count <= 1)).toBe(true);
  });
});

describe('medianSalaries', () => {
  it('бере середину вилки, коли є обидві межі', async () => {
    const rows = await medianSalaries('seniority');
    expect(rows.find((row) => row.group === 'senior')!.median).toBe(5000);
    expect(rows.find((row) => row.group === 'middle')!.median).toBe(3000);
  });

  it('групування за країною бере країну компанії', async () => {
    const rows = await medianSalaries('country');
    expect(rows[0]!.group).toBe('UA');
    expect(rows[0]!.count).toBe(2);
  });
});

describe('lifetimes', () => {
  it('медіана часу життя рахується лише по закритих', async () => {
    const stats = await lifetimes();
    expect(stats.closedCount).toBe(2);
    expect(stats.medianDays).toBeGreaterThan(5);
    expect(stats.medianDays).toBeLessThan(25);
  });

  it('вакансія, що висить понад 120 днів, це підозра на ghost job', async () => {
    const stats = await lifetimes(120);
    expect(stats.ghosts).toHaveLength(1);
    expect(stats.ghosts[0]!.title).toBe('Вічна вакансія');
    expect(stats.ghosts[0]!.days).toBeGreaterThanOrEqual(200);
  });

  it('поріг налаштовується', async () => {
    expect((await lifetimes(1000)).ghosts).toHaveLength(0);
  });
});

describe('perDay', () => {
  it('групує нові вакансії за днями', async () => {
    const rows = await perDay(365);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(4);
  });
});
