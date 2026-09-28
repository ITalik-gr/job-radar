import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';

/*
 * The career page pass that nothing used to run. Fixtures: the same page before and after
 * one role closed and one opened.
 */
const pages = { current: readFileSync('fixtures/careers/acme-v1.html', 'utf8') };

vi.mock('../src/lib/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/http.js')>()),
  fetchText: vi.fn(async (url: string) => ({ body: url.includes('/careers') ? pages.current : '', status: 200, url })),
}));

const { blocksToVacancies, syncCareers } = await import('../src/pipeline/careers.js');

let acme: Company;

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme-careers.com', source: 'test' })).company;
  await getDb()
    .update(companies)
    .set({ careersKind: 'html', careersUrl: 'https://acme-careers.com/careers' })
    .where(eq(companies.id, acme.id));
});

describe('blocksToVacancies', () => {
  it('resolves relative links against the page and skips blocks without a title', () => {
    const items = blocksToVacancies({ name: 'Acme', domain: 'acme.com' }, 'https://acme.com/careers', [
      { hash: 'a', text: 'frontend engineer, remote', url: '/jobs/1', title: 'frontend engineer' },
      { hash: 'b', text: 'no title here', url: null, title: null },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: 'https://acme.com/jobs/1', externalId: 'a', source: 'careers' });
  });
});

describe('syncCareers', () => {
  it('the first pass stores the page blocks as vacancies', async () => {
    const result = await syncCareers({ skipLlm: true });
    expect(result.checked).toBe(1);
    expect(result.itemsNew).toBeGreaterThan(0);
  });

  it('a company checked today is not due again', async () => {
    const result = await syncCareers({ skipLlm: true });
    expect(result.checked).toBe(0);
  });

  it('when due again, a role gone from the page gets closed and a new one appears', async () => {
    await getDb().update(companies).set({ lastChecked: Date.now() - 2 * 86_400_000 }).where(eq(companies.id, acme.id));
    pages.current = readFileSync('fixtures/careers/acme-v2.html', 'utf8');

    const result = await syncCareers({ skipLlm: true });
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(result.itemsNew).toBeGreaterThanOrEqual(1);

    const rows = await getDb().select().from(vacancies).where(eq(vacancies.companyId, acme.id));
    expect(rows.some((row) => row.closedAt !== null)).toBe(true);
  });

  it('an empty page is an error, not a reason to close everything', async () => {
    await getDb().update(companies).set({ lastChecked: Date.now() - 2 * 86_400_000 }).where(eq(companies.id, acme.id));
    pages.current = '<html><body><div id="root"></div></body></html>';

    const result = await syncCareers({ skipLlm: true });
    expect(result.closed).toBe(0);
    expect(result.errors[0]).toContain('no vacancy blocks');
  });
});
