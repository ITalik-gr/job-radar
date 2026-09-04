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

describe('сховок налаштувань', () => {
  it('без запису віддає значення за замовчуванням', async () => {
    expect(await readSetting('немає-такого', { a: 1 })).toEqual({ a: 1 });
  });

  it('записане читається назад', async () => {
    await writeSetting('getro:domains', { 'jobs.x.com:acme': 'acme.dev' });
    expect(await readSetting('getro:domains', {})).toEqual({ 'jobs.x.com:acme': 'acme.dev' });
  });

  it('повторний запис перезаписує, а не дублює', async () => {
    await writeSetting('k', { v: 1 });
    await writeSetting('k', { v: 2 });

    expect(await readSetting('k', {})).toEqual({ v: 2 });
    expect(await getDb().select().from(settings)).toHaveLength(1);
  });

  it('null у значенні зберігається як null, а не зникає', async () => {
    // Для кешу доменів це важливо: null означає "перевіряли, домену немає",
    // і без нього ми ходили б на той самий сайт щоразу заново.
    await writeSetting('k', { 'jobs.x.com:acme': null });
    expect(await readSetting<Record<string, string | null>>('k', {})).toEqual({
      'jobs.x.com:acme': null,
    });
  });
});
