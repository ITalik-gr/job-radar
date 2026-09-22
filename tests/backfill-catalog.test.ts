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
  it('moves the rate and minimum project from tags into columns and cleans the tags', async () => {
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
    // Only services stay in the tags, the rest moved into columns.
    expect(company.tags).toEqual(['Web Development']);
  });

  it('does not touch already filled columns and does not invent data from empty tags', async () => {
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

    // A fresh crawl is more accurate than a tag that has sat there for years, so the column wins.
    expect(fresh.hourlyRate).toBe('$100 - $149 / hr');
    expect(bare.hourlyRate).toBeNull();
    expect(bare.minProject).toBeNull();
    expect(bare.tags).toEqual(['Design']);
  });

  it('running it again changes nothing', async () => {
    const second = await backfillCatalogFields();
    expect(second.rate).toBe(0);
    expect(second.tagsRemoved).toBe(0);
  });
});

describe('cleanTags', () => {
  it('strips the chart percentage from a service name and merges duplicates', () => {
    expect(cleanTags(['25% Web Development', 'Web development', 'UX/UI Design'])).toEqual([
      'Web Development',
      'UX/UI Design',
    ]);
  });

  it('removes chart captions, ratings and buttons that are not tags', () => {
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

  it('invents nothing from an empty list', () => {
    expect(cleanTags([])).toEqual([]);
  });
});
