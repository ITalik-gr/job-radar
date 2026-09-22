import { rmSync } from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { runs } from '../src/db/schema.js';
import { isOverdue, lastSuccessAt, withRun } from '../src/lib/runs.js';

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  const { sqlite } = runMigrations();
  sqlite.close();
});

async function lastRun() {
  const [row] = await getDb().select().from(runs).orderBy(desc(runs.id)).limit(1);
  return row!;
}

describe('withRun', () => {
  it('the first empty run is ok, there is no history yet', async () => {
    await withRun('test:source', async () => ({ itemsFound: 0, itemsNew: 0, errors: [] }));
    expect((await lastRun()).status).toBe('ok');
  });

  it('a successful run records what was found', async () => {
    await withRun('test:source', async () => ({ itemsFound: 12, itemsNew: 3, errors: [] }));
    const row = await lastRun();
    expect(row.status).toBe('ok');
    expect(row.itemsFound).toBe(12);
    expect(row.finishedAt).toBeGreaterThan(0);
  });

  it('zero after a non-empty history is warn, not success', async () => {
    await withRun('test:source', async () => ({ itemsFound: 0, itemsNew: 0, errors: [] }));
    expect((await lastRun()).status).toBe('warn');
  });

  it('partial errors give warn', async () => {
    await withRun('test:source', async () => ({ itemsFound: 5, itemsNew: 1, errors: ['acme: 500'] }));
    const row = await lastRun();
    expect(row.status).toBe('warn');
    expect(row.errors).toEqual(['acme: 500']);
  });

  it('an exception gives status error and is not swallowed', async () => {
    await expect(
      withRun('test:source', async () => {
        throw new Error('board crashed');
      }),
    ).rejects.toThrow('board crashed');

    const row = await lastRun();
    expect(row.status).toBe('error');
    expect(row.errors).toEqual(['board crashed']);
  });
});

describe('stale runs', () => {
  it('a stuck running row is closed as stale before a new run starts', async () => {
    const db = getDb();

    // A run that was "killed" two hours ago and stayed in running forever.
    const [stale] = await db
      .insert(runs)
      .values({
        source: 'stale-source',
        status: 'running',
        startedAt: Date.now() - 2 * 60 * 60 * 1000,
      })
      .returning();

    await withRun('stale-source', async () => ({ itemsFound: 1, itemsNew: 1, errors: [] }));

    const [after] = await db.select().from(runs).where(eq(runs.id, stale!.id));
    expect(after!.status).toBe('error');
    expect(after!.finishedAt).not.toBeNull();
  });

  it('a fresh running row is left alone: it may really be in progress', async () => {
    const db = getDb();
    const [fresh] = await db
      .insert(runs)
      .values({ source: 'fresh-source', status: 'running', startedAt: Date.now() })
      .returning();

    await withRun('fresh-source', async () => ({ itemsFound: 1, itemsNew: 1, errors: [] }));

    const [after] = await db.select().from(runs).where(eq(runs.id, fresh!.id));
    expect(after!.status).toBe('running');
  });
});

describe('catching up on missed runs', () => {
  it('it is time to run if the job never ran', () => {
    expect(isOverdue(null, 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('it is time to run if more time passed than the period', () => {
    const now = Date.now();
    expect(isOverdue(now - 7 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, now)).toBe(true);
  });

  it('not time yet if it just ran', () => {
    const now = Date.now();
    expect(isOverdue(now - 60 * 1000, 6 * 60 * 60 * 1000, now)).toBe(false);
  });

  it('the last success is taken from successful runs, not from any run', async () => {
    const db = getDb();
    const source = 'catchup-source';

    // A failed run must not count as done, otherwise catch-up would decide after a
    // failure that everything is fine and the source would stay silent until next time.
    await db.insert(runs).values({
      source,
      status: 'error',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      itemsFound: 0,
      itemsNew: 0,
    });

    expect(await lastSuccessAt(source)).toBeNull();

    const finished = Date.now();
    await db.insert(runs).values({
      source,
      status: 'ok',
      startedAt: finished - 1000,
      finishedAt: finished,
      itemsFound: 3,
      itemsNew: 3,
    });

    expect(await lastSuccessAt(source)).toBe(finished);
  });

  it('a source with no runs at all has no last success', async () => {
    expect(await lastSuccessAt('source-that-does-not-exist')).toBeNull();
  });
});
