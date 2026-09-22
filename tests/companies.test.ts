import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, companyState } from '../src/db/schema.js';
import { companiesForAts, upsertCompany } from '../src/pipeline/companies.js';

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  const { sqlite } = runMigrations();
  sqlite.close();
});

describe('upsertCompany', () => {
  it('creates a company and the initial new state', async () => {
    const { company, created } = await upsertCompany({
      name: 'Acme',
      domain: 'https://www.acme.com/careers',
      source: 'csv',
      careersKind: 'greenhouse',
      careersSlug: 'acme',
      note: 'from a list',
    });

    expect(created).toBe(true);
    expect(company.domain).toBe('acme.com');

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, company.id));
    expect(state!.status).toBe('new');
    expect(state!.reason).toBe('from a list');
  });

  it('the same domain does not create a duplicate, it appends the source', async () => {
    const { company, created } = await upsertCompany({
      name: 'Acme Inc',
      domain: 'acme.com',
      source: 'dou',
      country: 'UA',
    });

    expect(created).toBe(false);
    expect(company.sources).toEqual(['csv', 'dou']);
    expect(company.country).toBe('UA');

    const rows = await getDb().select().from(companies).where(eq(companies.domain, 'acme.com'));
    expect(rows).toHaveLength(1);
  });

  it('does not overwrite an already known ATS with a new unknown one', async () => {
    const { company } = await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'manual' });
    expect(company.careersKind).toBe('greenhouse');
    expect(company.careersSlug).toBe('acme');
  });

  it('an invalid domain is an error, not a silent skip', async () => {
    await expect(upsertCompany({ name: 'X', domain: 'not a domain', source: 'csv' })).rejects.toThrow();
  });
});

describe('companiesForAts', () => {
  it('returns only companies with the given ATS and a non-empty slug', async () => {
    await upsertCompany({ name: 'NoSlug', domain: 'noslug.com', source: 'csv', careersKind: 'greenhouse' });
    await upsertCompany({ name: 'Lev', domain: 'lev.com', source: 'csv', careersKind: 'lever', careersSlug: 'lev' });

    const gh = await companiesForAts('greenhouse');
    expect(gh.map((c) => c.domain)).toEqual(['acme.com']);
    expect((await companiesForAts('lever')).map((c) => c.domain)).toEqual(['lev.com']);
  });
});

describe('reputation and the "Other" block', () => {
  it('rating and reviews are updated with fresh values, the rest only fills empty fields', async () => {
    await upsertCompany({
      name: 'Rated',
      domain: 'rated.com',
      source: 'clutch',
      rating: 4.4,
      reviewsCount: 8,
      hourlyRate: '$50 - $99 / hr',
      minProject: '$10,000+',
      foundedYear: 2015,
      extra: { 'Verified Profile': 'yes' },
    });

    const { company } = await upsertCompany({
      name: 'Rated',
      domain: 'rated.com',
      source: 'goodfirms',
      rating: 4.8,
      reviewsCount: 21,
      // Another catalog shows a shorter card. It must not overwrite what was already collected.
      hourlyRate: null,
      foundedYear: 1999,
      extra: { 'Verified Profile': 'no', Languages: 'English, Ukrainian' },
    });

    expect(company.rating).toBe(4.8);
    expect(company.reviewsCount).toBe(21);
    expect(company.hourlyRate).toBe('$50 - $99 / hr');
    expect(company.foundedYear).toBe(2015);
    expect(company.extra['Verified Profile']).toBe('yes');
    expect(company.extra.Languages).toBe('English, Ukrainian');
  });

  it('a company without a reputation is saved with empty fields, not zeros', async () => {
    const { company } = await upsertCompany({ name: 'Plain', domain: 'plain.com', source: 'csv' });
    expect(company.rating).toBeNull();
    expect(company.reviewsCount).toBeNull();
    expect(company.extra).toEqual({});
  });
});
