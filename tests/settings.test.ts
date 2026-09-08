import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { outreach, settings, templates } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
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
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  restoreTemplate,
  seedTemplates,
  slugify,
  updateTemplate,
} from '../src/pipeline/templates.js';

/** Запис листування потребує компанії, бо `outreach.company_id` це справжній звʼязок. */
async function companyForOutreach(domain: string): Promise<number> {
  const { company } = await upsertCompany({ name: domain, domain, source: 'test' });
  return company.id;
}

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

  /*
   * Секція репутації зʼявилась пізніше за конфіг. Конфіг, збережений з інтерфейсу
   * до її появи, мусить лишатись валідним, інакше скоринг мовчки відкотився б
   * до вшитого, і правки порогів з інтерфейсу перестали б діяти.
   */
  it('репутація студій зберігається з інтерфейсу і має дефолти в старому конфізі', async () => {
    const base = loadRules();
    const withoutReputation = { ...base, companies: { ...base.companies, reputation: undefined } };

    await saveRules(withoutReputation);
    expect(rules().companies.reputation.goodRating).toBe(4.5);

    await saveRules({
      ...base,
      companies: { ...base.companies, reputation: { ...base.companies.reputation, goodRatingBonus: 7 } },
    });
    expect(rules().companies.reputation.goodRatingBonus).toBe(7);
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

  /*
   * Форма редактора шле всі поля одним патчем. Тест тримає рівно цей набір, бо
   * саме він одного разу розʼїхався: мова, роль і перший абзац не доїжджали до бази.
   */
  it('патч зберігає всі редаговані поля разом', async () => {
    const created = await createTemplate({ name: 'Повний набір' });

    const saved = await updateTemplate(created.id, {
      name: 'Повний набір 2',
      slug: created.slug,
      kind: 'studio',
      forKind: 'design',
      subject: 'Тема для {{company}}',
      intro: 'Перший абзац про {{company}}',
      body: '{{intro}} далі текст',
      note: 'коли доречно',
      language: 'en',
      targetType: 'studio_named',
    });

    expect(saved).toMatchObject({
      name: 'Повний набір 2',
      kind: 'studio',
      forKind: 'design',
      subject: 'Тема для {{company}}',
      intro: 'Перший абзац про {{company}}',
      body: '{{intro}} далі текст',
      note: 'коли доречно',
      language: 'en',
      targetType: 'studio_named',
    });
  });

  it('універсальний шаблон зберігається порожнім типом компанії', async () => {
    const created = await createTemplate({ name: 'Універсальний', forKind: 'design' });
    expect((await updateTemplate(created.id, { forKind: null })).forKind).toBeNull();
  });

  it('архів ховає шаблон і повертає його назад', async () => {
    const created = await createTemplate({ name: 'Разовий' });
    await archiveTemplate(created.id);
    expect((await getDb().select().from(templates).where(eq(templates.id, created.id)))[0]!.archived).toBe(true);

    await restoreTemplate(created.id);
    expect((await getDb().select().from(templates).where(eq(templates.id, created.id)))[0]!.archived).toBe(false);
  });

  it('видалення стирає шаблон, а історія листування лишається читабельною', async () => {
    const created = await createTemplate({ name: 'На видалення' });
    const companyId = await companyForOutreach('delete-me.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    const result = await deleteTemplate(created.id);
    expect(result.keptInHistory).toBe(1);

    const rows = await getDb().select().from(templates).where(eq(templates.id, created.id));
    expect(rows).toHaveLength(0);

    // Ключ у листуванні це знімок на момент листа, тому переживає видалення шаблона.
    const history = await getDb().select().from(outreach).where(eq(outreach.companyId, companyId));
    expect(history[0]!.templateUsed).toBe(created.slug);
  });

  it('видалений стартовий шаблон не воскресає на наступному відкритті сторінки', async () => {
    await seedTemplates();
    const [seeded] = await getDb().select().from(templates).where(eq(templates.slug, 'referral'));
    await deleteTemplate(seeded!.id);

    expect(await seedTemplates()).toBe(0);
    expect(await getDb().select().from(templates).where(eq(templates.slug, 'referral'))).toHaveLength(0);
  });

  it('перейменування ключа переписує історію листування на новий ключ', async () => {
    const created = await createTemplate({ name: 'Старий ключ' });
    const companyId = await companyForOutreach('rename-me.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    const renamed = await updateTemplate(created.id, { slug: 'Новий Ключ 2' });
    expect(renamed.slug).toBe('новий_ключ_2');

    const history = await getDb().select().from(outreach).where(eq(outreach.companyId, companyId));
    expect(history[0]!.templateUsed).toBe('новий_ключ_2');
  });

  it('зайнятий ключ отримує суфікс замість помилки', async () => {
    const first = await createTemplate({ name: 'Однакова назва' });
    const second = await createTemplate({ name: 'Однакова назва' });
    expect(second.slug).toBe(`${first.slug}_2`);
  });

  it('дублікат це окремий шаблон з власним ключем і тим самим текстом', async () => {
    const created = await createTemplate({ name: 'Оригінал', kind: 'studio', body: 'текст листа' });
    const copy = await duplicateTemplate(created.id);

    expect(copy.id).not.toBe(created.id);
    expect(copy.slug).not.toBe(created.slug);
    expect(copy.body).toBe('текст листа');
    expect(copy.kind).toBe('studio');
  });

  it('список показує, скільки листів написано кожним шаблоном', async () => {
    const created = await createTemplate({ name: 'Робочий' });
    const companyId = await companyForOutreach('usage.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    const row = (await listTemplates()).find((item) => item.id === created.id);
    expect(row!.usageCount).toBe(1);
  });

  it('шаблон можна прив язати до типу компанії і відвʼязати назад', async () => {
    const created = await createTemplate({ name: 'Під дизайн', kind: 'studio', forKind: 'design' });
    expect(created.forKind).toBe('design');

    const universal = await updateTemplate(created.id, { forKind: null });
    expect(universal.forKind).toBeNull();
  });

  it('без привʼязки шаблон універсальний', async () => {
    expect((await createTemplate({ name: 'Універсальний' })).forKind).toBeNull();
  });

  it('фільтр за типом віддає лише свій вид', async () => {
    await seedTemplates();
    const studio = await listTemplates('studio');
    expect(studio.length).toBeGreaterThan(0);
    expect(studio.every((row) => row.kind === 'studio')).toBe(true);
  });
});
