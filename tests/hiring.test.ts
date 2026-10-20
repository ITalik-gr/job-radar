import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies } from '../src/db/schema.js';
import { marketOf, upsertCompany } from '../src/pipeline/companies.js';
import { HIRING_FRESH_DAYS, hiringNow, isDevRole, recordHiring } from '../src/pipeline/hiring.js';
import type { RawVacancy } from '../src/sources/registry.js';

function posting(over: Partial<RawVacancy> = {}): RawVacancy {
  return {
    source: 'test',
    externalId: null,
    url: 'https://board.example/1',
    title: 'Senior Frontend Engineer',
    rawText: '',
    companyName: 'Acme',
    companyDomain: 'acme.io',
    location: null,
    remote: null,
    postedAt: null,
    ...over,
  };
}

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

describe('developer role', () => {
  it.each(['Senior Frontend Engineer', 'Full-stack developer', 'React Developer', 'Розробник Node.js'])(
    '%s counts',
    (title) => expect(isDevRole(title)).toBe(true),
  );

  it.each(['Account Executive', 'Product Designer', 'QA Engineer', 'DevOps Engineer', 'Engineering Manager', null])(
    '%s does not',
    (title) => expect(isDevRole(title)).toBe(false),
  );
});

describe('hiring signal', () => {
  it('a board pass creates the company and marks it hiring', async () => {
    const stats = await recordHiring([posting(), posting({ title: 'Backend Developer' }), posting({ title: 'Recruiter' })]);
    expect(stats).toMatchObject({ seen: 3, companies: 1, created: 1, hiring: 1 });

    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'acme.io'));
    expect(row?.hiringDevs).toBe(true);
    expect(row?.hiringRoles).toBe(2);
    expect(row && hiringNow(row)).toBe(true);
  });

  it('a posting with no domain and an unknown name is skipped, never invented', async () => {
    const stats = await recordHiring([posting({ companyDomain: null, companyName: 'Nobody Inc' })]);
    expect(stats).toMatchObject({ skipped: 1, created: 0 });
  });

  it('a complete ATS board with no developer role clears the signal', async () => {
    const [acme] = await getDb().select().from(companies).where(eq(companies.domain, 'acme.io'));
    await recordHiring([posting({ title: 'Sales Lead' })], acme);

    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'acme.io'));
    expect(row?.hiringDevs).toBe(false);
  });

  it('the signal fades after a while without a fresh posting', () => {
    const now = Date.now();
    const seen = now - (HIRING_FRESH_DAYS + 1) * 86_400_000;
    expect(hiringNow({ hiringDevs: true, hiringSeenAt: seen }, now)).toBe(false);
    expect(hiringNow({ hiringDevs: true, hiringSeenAt: now - 86_400_000 }, now)).toBe(true);
  });
});

describe('market', () => {
  it.each([
    ['UA', 'ua'],
    ['Ukraine', 'ua'],
    ['Україна', 'ua'],
    ['PL', 'intl'],
    [null, null],
    ['', null],
  ] as const)('%s is %s', (country, market) => expect(marketOf(country)).toBe(market));

  it('is stored on upsert', async () => {
    const { company } = await upsertCompany({ name: 'Kyiv Dental', domain: 'dental.kyiv.ua', country: 'UA', source: 'test' });
    expect(company.market).toBe('ua');
  });
});
