import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { queueItems, vacancies } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { mergeWeeklyDuplicates } from '../src/pipeline/merge-duplicates.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

/*
 * What the old weekly key left behind: one vacancy as a chain of rows, each opened in the
 * same pass that closed the previous one.
 */
beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  const { company } = await upsertCompany({ name: 'Chain', domain: 'chain.com', source: 'test' });

  const row = (week: number, over: Record<string, unknown> = {}) => ({
    companyId: company.id,
    source: 'greenhouse',
    url: 'https://chain.com/jobs/1',
    title: 'Frontend Engineer',
    dedupeKey: `chain.com|frontend-engineer|2026-W${week}`,
    firstSeen: T0 + (week - 36) * 7 * DAY,
    lastSeen: T0 + (week - 36) * 7 * DAY + 6 * DAY,
    closedAt: T0 + (week - 35) * 7 * DAY,
    score: 5,
    ...over,
  });

  await getDb()
    .insert(vacancies)
    .values([row(36), row(37), row(38, { closedAt: null, score: 9, llmRelevance: 80 })]);
  const all = await getDb().select().from(vacancies);
  await getDb().insert(queueItems).values({ day: '2026-09-20', vacancyId: all[2]!.id, position: 1 });

  // Re-posted months later: a separate vacancy, must stay separate.
  await getDb().insert(vacancies).values(
    row(50, { firstSeen: T0 + 100 * DAY, lastSeen: T0 + 101 * DAY, closedAt: null, dedupeKey: 'chain.com|frontend-engineer|2026-W50' }),
  );
});

describe('merging weekly duplicates', () => {
  it('a dry run only counts', async () => {
    const report = await mergeWeeklyDuplicates();
    expect(report).toMatchObject({ groups: 1, merged: 2, applied: false });
    expect(await getDb().select().from(vacancies)).toHaveLength(4);
  });

  it('apply folds the chain into its first row and keeps the re-post apart', async () => {
    const report = await mergeWeeklyDuplicates({ apply: true });
    expect(report).toMatchObject({ groups: 1, merged: 2, remaining: 0 });

    const rows = await getDb().select().from(vacancies).orderBy(vacancies.firstSeen);
    expect(rows).toHaveLength(2);
    const [kept] = rows;
    expect(kept!.dedupeKey).toBe('chain.com|frontend-engineer|2026-W36');
    expect(kept!.firstSeen).toBe(T0);
    expect(kept!.closedAt).toBeNull();
    expect(kept!.score).toBe(9);
    expect(kept!.llmRelevance).toBe(80);

    const [card] = await getDb().select().from(queueItems);
    expect(card!.vacancyId).toBe(kept!.id);
  });

  it('a second run finds nothing', async () => {
    expect((await mergeWeeklyDuplicates({ apply: true })).groups).toBe(0);
  });
});
