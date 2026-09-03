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
  it('створює компанію і початковий стан new', async () => {
    const { company, created } = await upsertCompany({
      name: 'Acme',
      domain: 'https://www.acme.com/careers',
      source: 'csv',
      careersKind: 'greenhouse',
      careersSlug: 'acme',
      note: 'зі списку',
    });

    expect(created).toBe(true);
    expect(company.domain).toBe('acme.com');

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, company.id));
    expect(state!.status).toBe('new');
    expect(state!.reason).toBe('зі списку');
  });

  it('той самий домен не створює дубль, а дописує джерело', async () => {
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

  it('не перезаписує вже відомий ATS новим невідомим', async () => {
    const { company } = await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'manual' });
    expect(company.careersKind).toBe('greenhouse');
    expect(company.careersSlug).toBe('acme');
  });

  it('невалідний домен це помилка, а не мовчазний пропуск', async () => {
    await expect(upsertCompany({ name: 'X', domain: 'не домен', source: 'csv' })).rejects.toThrow();
  });
});

describe('companiesForAts', () => {
  it('віддає лише компанії з потрібним ATS і непорожнім slug', async () => {
    await upsertCompany({ name: 'NoSlug', domain: 'noslug.com', source: 'csv', careersKind: 'greenhouse' });
    await upsertCompany({ name: 'Lev', domain: 'lev.com', source: 'csv', careersKind: 'lever', careersSlug: 'lev' });

    const gh = await companiesForAts('greenhouse');
    expect(gh.map((c) => c.domain)).toEqual(['acme.com']);
    expect((await companiesForAts('lever')).map((c) => c.domain)).toEqual(['lev.com']);
  });
});
