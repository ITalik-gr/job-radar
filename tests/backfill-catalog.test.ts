import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { backfillCatalogFields, cleanTags } from '../src/pipeline/backfill-catalog.js';

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  const { sqlite } = runMigrations();
  sqlite.close();
});

describe('backfillCatalogFields', () => {
  it('переносить ставку і мінімальний проєкт з тегів у колонки і чистить теги', async () => {
    await upsertCompany({
      name: 'Old Studio',
      domain: 'old.com',
      source: 'clutch',
      tags: ['Web Development', '$50 - $99 / hr', '$10,000+', 'Founded 2015'],
    });

    const stats = await backfillCatalogFields();
    expect(stats.rate).toBe(1);
    expect(stats.minProject).toBe(1);
    expect(stats.founded).toBe(1);

    const { company } = await upsertCompany({ name: 'Old Studio', domain: 'old.com', source: 'clutch' });
    expect(company.hourlyRate).toBe('$50 - $99 / hr');
    expect(company.minProject).toBe('$10,000+');
    expect(company.foundedYear).toBe(2015);
    // У тегах лишаються тільки послуги, бо решта переїхала в колонки.
    expect(company.tags).toEqual(['Web Development']);
  });

  it('не чіпає вже заповнені колонки і не вигадує даних з порожніх тегів', async () => {
    await upsertCompany({
      name: 'Fresh',
      domain: 'fresh.com',
      source: 'goodfirms',
      hourlyRate: '$100 - $149 / hr',
      tags: ['Design', '$25 - $49 / hr'],
    });
    await upsertCompany({ name: 'Bare', domain: 'bare.com', source: 'csv', tags: ['Design'] });

    await backfillCatalogFields();

    const { company: fresh } = await upsertCompany({ name: 'Fresh', domain: 'fresh.com', source: 'goodfirms' });
    const { company: bare } = await upsertCompany({ name: 'Bare', domain: 'bare.com', source: 'csv' });

    // Свіжий збір точніший за тег, який лежить роками, тому колонка виграє.
    expect(fresh.hourlyRate).toBe('$100 - $149 / hr');
    expect(bare.hourlyRate).toBeNull();
    expect(bare.minProject).toBeNull();
    expect(bare.tags).toEqual(['Design']);
  });

  it('повторний запуск нічого не міняє', async () => {
    const second = await backfillCatalogFields();
    expect(second.rate).toBe(0);
    expect(second.tagsRemoved).toBe(0);
  });
});

describe('cleanTags', () => {
  it('знімає частку діаграми з назви послуги і зводить дублі', () => {
    expect(cleanTags(['25% Web Development', 'Web development', 'UX/UI Design'])).toEqual([
      'Web Development',
      'UX/UI Design',
    ]);
  });

  it('прибирає підписи діаграм, оцінки і кнопки, які тегами не є', () => {
    const tags = cleanTags([
      'Allocation of expertise by %',
      'Was this helpful?',
      '9.5/10 Market Presence',
      '20/20 Reviews',
      '9 reviews mention Web Development',
      'Service focus 50% Web Design 50% Other',
      'Web Design 45% Other',
      'Read 4 Reviews',
      '+1 service',
      'Mobile App Development',
    ]);
    expect(tags).toEqual(['Mobile App Development']);
  });

  it('нічого не вигадує з порожнього списку', () => {
    expect(cleanTags([])).toEqual([]);
  });
});
