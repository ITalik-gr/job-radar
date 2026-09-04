import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { settings, templates } from '../src/db/schema.js';
import {
  RULES_KEY,
  loadRules,
  refreshRulesFromDb,
  resetRules,
  resetRulesCache,
  rules,
  rulesSource,
  saveRules,
} from '../src/pipeline/rules.js';
import {
  archiveTemplate,
  createTemplate,
  listTemplates,
  seedTemplates,
  slugify,
  updateTemplate,
} from '../src/pipeline/templates.js';

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

// Файл бази між тестами не видаляємо: зʼєднання вже відкрите і після rmSync далі
// пише в той самий inode, тобто чистки не відбувається. Чистимо самі таблиці.
beforeEach(async () => {
  await getDb().delete(settings);
  await getDb().delete(templates);
  resetRulesCache();
  await refreshRulesFromDb();
});

describe('правила з бази', () => {
  it('без запису в базі беруться вшиті значення', async () => {
    expect(rulesSource()).not.toBe('db');
    expect(rules().threshold).toBe(loadRules().threshold);
  });

  it('збережені правила перекривають вшиті і виживають скидання кешу', async () => {
    await saveRules({ ...loadRules(), threshold: 42 });
    expect(rules().threshold).toBe(42);
    expect(rulesSource()).toBe('db');

    resetRulesCache();
    await refreshRulesFromDb();
    expect(rules().threshold).toBe(42);
  });

  it('невалідний конфіг не потрапляє в базу', async () => {
    await expect(saveRules({ threshold: 'багато' })).rejects.toThrow();

    const rows = await getDb().select().from(settings).where(eq(settings.key, RULES_KEY));
    expect(rows).toHaveLength(0);
    expect(rules().threshold).toBe(loadRules().threshold);
  });

  it('скидання прибирає запис і вертає значення за замовчуванням', async () => {
    await saveRules({ ...loadRules(), threshold: 42 });
    await resetRules();

    expect(rules().threshold).toBe(loadRules().threshold);
    expect(rulesSource()).not.toBe('db');
    expect(await getDb().select().from(settings)).toHaveLength(0);
  });

  it('стоп-слово і вага термінa зберігаються як частина повного конфіга', async () => {
    const current = loadRules();
    await saveRules({ ...current, stopWords: [...current.stopWords, 'kotlin'].sort() });
    expect(rules().stopWords).toContain('kotlin');

    await saveRules({
      ...rules(),
      weights: { ...rules().weights, terms: { ...rules().weights.terms, hono: 4 } },
    });
    expect(rules().weights.terms.hono).toBe(4);
    expect(rules().stopWords).toContain('kotlin');
  });
});

describe('шаблони', () => {
  it('стартовий набір доливається один раз', async () => {
    expect(await seedTemplates()).toBeGreaterThan(0);
    const first = await listTemplates();
    expect(await seedTemplates()).toBe(0);
    expect(await listTemplates()).toHaveLength(first.length);
  });

  it('slug робиться з назви і лишається стабільним при перейменуванні', async () => {
    const created = await createTemplate({ name: 'Пітч для студій', body: 'текст' });
    expect(created.slug).toBe(slugify('Пітч для студій'));

    const renamed = await updateTemplate(created.id, { name: 'Інша назва' });
    expect(renamed.name).toBe('Інша назва');
    expect(renamed.slug).toBe(created.slug);
  });

  it('видалення архівує, а не стирає: мітка лишається в історії листування', async () => {
    const created = await createTemplate({ name: 'Разовий' });
    await archiveTemplate(created.id);

    const rows = await getDb().select().from(templates).where(eq(templates.id, created.id));
    expect(rows[0]!.archived).toBe(true);
  });

  it('фільтр за типом віддає лише свій вид', async () => {
    await seedTemplates();
    const studio = await listTemplates('studio');
    expect(studio.length).toBeGreaterThan(0);
    expect(studio.every((row) => row.kind === 'studio')).toBe(true);
  });
});
