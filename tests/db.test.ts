import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.node.js';
import { companies, companyState, vacancies } from '../src/db/schema.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const dbPath = join(tmpdir(), `radar-test-${Date.now()}.db`);
let ctx: ReturnType<typeof createDb>;

beforeAll(() => {
  ctx = createDb(dbPath);
  migrate(ctx.db, { migrationsFolder: 'src/db/migrations' });
});

afterAll(() => {
  ctx.sqlite.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

describe('схема', () => {
  it('зберігає компанію з масивами як JSON', async () => {
    const [company] = await ctx.db
      .insert(companies)
      .values({
        name: 'Acme',
        domain: 'acme.com',
        sources: ['dou'],
        techHints: ['next.js', 'react'],
        careersKind: 'greenhouse',
        careersSlug: 'acme',
      })
      .returning();

    expect(company!.techHints).toEqual(['next.js', 'react']);
    expect(company!.firstSeen).toBeGreaterThan(0);
  });

  it('домен унікальний', async () => {
    await expect(
      ctx.db.insert(companies).values({ name: 'Acme дубль', domain: 'acme.com' }),
    ).rejects.toThrow();
  });

  it('dedupe_key унікальний, повторна вакансія не дублюється', async () => {
    const [company] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.domain, 'acme.com'));

    const values = {
      companyId: company!.id,
      source: 'greenhouse',
      url: 'https://acme.com/jobs/1',
      title: 'Senior Frontend Developer',
      dedupeKey: 'acme.com|senior-frontend-developer|2026-W36',
    };

    await ctx.db.insert(vacancies).values(values);
    await expect(ctx.db.insert(vacancies).values(values)).rejects.toThrow();
  });

  it('стан компанії один на компанію і чистить каскадом', async () => {
    const [company] = await ctx.db
      .insert(companies)
      .values({ name: 'Temp', domain: 'temp.dev' })
      .returning();

    await ctx.db.insert(companyState).values({ companyId: company!.id, status: 'interesting' });
    await expect(
      ctx.db.insert(companyState).values({ companyId: company!.id, status: 'new' }),
    ).rejects.toThrow();

    await ctx.db.delete(companies).where(eq(companies.id, company!.id));
    const left = await ctx.db
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, company!.id));
    expect(left).toHaveLength(0);
  });
});
