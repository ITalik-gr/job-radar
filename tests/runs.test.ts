import { rmSync } from 'node:fs';
import { desc } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { runs } from '../src/db/schema.js';
import { withRun } from '../src/lib/runs.js';

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
  it('перший порожній прогін це ok, історії ще немає', async () => {
    await withRun('test:source', async () => ({ itemsFound: 0, itemsNew: 0, errors: [] }));
    expect((await lastRun()).status).toBe('ok');
  });

  it('успішний прогін записує знайдене', async () => {
    await withRun('test:source', async () => ({ itemsFound: 12, itemsNew: 3, errors: [] }));
    const row = await lastRun();
    expect(row.status).toBe('ok');
    expect(row.itemsFound).toBe(12);
    expect(row.finishedAt).toBeGreaterThan(0);
  });

  it('нуль після непорожньої історії це warn, а не успіх', async () => {
    await withRun('test:source', async () => ({ itemsFound: 0, itemsNew: 0, errors: [] }));
    expect((await lastRun()).status).toBe('warn');
  });

  it('часткові помилки дають warn', async () => {
    await withRun('test:source', async () => ({ itemsFound: 5, itemsNew: 1, errors: ['acme: 500'] }));
    const row = await lastRun();
    expect(row.status).toBe('warn');
    expect(row.errors).toEqual(['acme: 500']);
  });

  it('виняток дає status error і не ковтається', async () => {
    await expect(
      withRun('test:source', async () => {
        throw new Error('дошка впала');
      }),
    ).rejects.toThrow('дошка впала');

    const row = await lastRun();
    expect(row.status).toBe('error');
    expect(row.errors).toEqual(['дошка впала']);
  });
});
