import { rmSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { settings } from '../src/db/schema.js';
import { readSetting, writeSetting } from '../src/lib/settings-store.js';

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

beforeEach(async () => {
  await getDb().delete(settings);
});

describe('settings store', () => {
  it('returns the default value when there is no record', async () => {
    expect(await readSetting('no-such-key', { a: 1 })).toEqual({ a: 1 });
  });

  it('a written value is read back', async () => {
    await writeSetting('getro:domains', { 'jobs.x.com:acme': 'acme.dev' });
    expect(await readSetting('getro:domains', {})).toEqual({ 'jobs.x.com:acme': 'acme.dev' });
  });

  it('a repeat write overwrites rather than duplicates', async () => {
    await writeSetting('k', { v: 1 });
    await writeSetting('k', { v: 2 });

    expect(await readSetting('k', {})).toEqual({ v: 2 });
    expect(await getDb().select().from(settings)).toHaveLength(1);
  });

  it('null in a value is stored as null, not dropped', async () => {
    // This matters for the domain cache: null means "checked, there is no domain",
    // and without it we would hit the same site over again every time.
    await writeSetting('k', { 'jobs.x.com:acme': null });
    expect(await readSetting<Record<string, string | null>>('k', {})).toEqual({
      'jobs.x.com:acme': null,
    });
  });
});
