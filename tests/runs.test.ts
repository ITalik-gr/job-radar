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

describe('обірвані прогони', () => {
  it('підвислий running закривається як обірваний перед новим запуском', async () => {
    const db = getDb();

    // Прогін, який "убили" дві години тому і який лишився в running назавжди.
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

  it('свіжий running не чіпається: він може бути справді робочим', async () => {
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

describe('наздоганяння пропущених запусків', () => {
  it('час запускати, якщо завдання не відпрацьовувало ніколи', () => {
    expect(isOverdue(null, 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('час запускати, якщо минуло більше за період', () => {
    const now = Date.now();
    expect(isOverdue(now - 7 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, now)).toBe(true);
  });

  it('не час, якщо щойно відпрацювало', () => {
    const now = Date.now();
    expect(isOverdue(now - 60 * 1000, 6 * 60 * 60 * 1000, now)).toBe(false);
  });

  it('останній успіх береться з успішних прогонів, а не з будь-яких', async () => {
    const db = getDb();
    const source = 'catchup-source';

    // Невдалий прогін не має вважатись відпрацьованим, інакше після падіння
    // наздоганяння вирішить, що все гаразд, і джерело мовчатиме до наступного разу.
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

  it('джерело без жодного прогону не має останнього успіху', async () => {
    expect(await lastSuccessAt('джерела-такого-немає')).toBeNull();
  });
});
