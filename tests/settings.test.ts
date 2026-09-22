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

/** An outreach record needs a company, since `outreach.company_id` is a real relation. */
async function companyForOutreach(domain: string): Promise<number> {
  const { company } = await upsertCompany({ name: domain, domain, source: 'test' });
  return company.id;
}

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

// We do not delete the database file between tests: the connection is already open, and
// after rmSync it keeps writing to the same inode, so no actual cleanup happens. We clear
// the tables themselves instead.
beforeEach(async () => {
  await getDb().delete(settings);
  await getDb().delete(templates);
  resetRulesCache();
  await refreshRulesFromDb();
});

describe('rules from the database', () => {
  it('with no record in the database, the built-in values are used', async () => {
    expect(rulesSource()).not.toBe('db');
    expect(rules().threshold).toBe(loadRules().threshold);
  });

  it('saved rules override the built-in ones and survive a cache reset', async () => {
    await saveRules({ ...loadRules(), threshold: 42 });
    expect(rules().threshold).toBe(42);
    expect(rulesSource()).toBe('db');

    resetRulesCache();
    await refreshRulesFromDb();
    expect(rules().threshold).toBe(42);
  });

  /*
   * The reputation section appeared after the config format did. Config saved from the UI
   * before it existed must stay valid, otherwise scoring would silently fall back to the
   * built-in values, and threshold edits from the UI would stop taking effect.
   */
  it('studio reputation is saved from the UI and has defaults in an old config', async () => {
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

  it('an invalid config does not reach the database', async () => {
    await expect(saveRules({ threshold: 'a lot' })).rejects.toThrow();

    const rows = await getDb().select().from(settings).where(eq(settings.key, RULES_KEY));
    expect(rows).toHaveLength(0);
    expect(rules().threshold).toBe(loadRules().threshold);
  });

  it('a reset removes the record and returns the default value', async () => {
    await saveRules({ ...loadRules(), threshold: 42 });
    await resetRules();

    expect(rules().threshold).toBe(loadRules().threshold);
    expect(rulesSource()).not.toBe('db');
    expect(await getDb().select().from(settings)).toHaveLength(0);
  });

  it('a stop word and a term weight are saved as part of the full config', async () => {
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

describe('templates', () => {
  it('the starter set is seeded once', async () => {
    expect(await seedTemplates()).toBeGreaterThan(0);
    const first = await listTemplates();
    expect(await seedTemplates()).toBe(0);
    expect(await listTemplates()).toHaveLength(first.length);
  });

  it('the slug is made from the name and stays stable across a rename', async () => {
    const created = await createTemplate({ name: 'Studio Pitch', body: 'text' });
    expect(created.slug).toBe(slugify('Studio Pitch'));

    const renamed = await updateTemplate(created.id, { name: 'Different Name' });
    expect(renamed.name).toBe('Different Name');
    expect(renamed.slug).toBe(created.slug);
  });

  /*
   * The editor form sends every field in one patch. The test keeps exactly this set, since
   * this is what broke once: language, role and the first paragraph never reached the database.
   */
  it('a patch saves every editable field together', async () => {
    const created = await createTemplate({ name: 'Full Set' });

    const saved = await updateTemplate(created.id, {
      name: 'Full Set 2',
      slug: created.slug,
      kind: 'studio',
      forKind: 'design',
      subject: 'Subject for {{company}}',
      intro: 'First paragraph about {{company}}',
      body: '{{intro}} more text',
      note: 'when it fits',
      language: 'en',
      targetType: 'studio_named',
    });

    expect(saved).toMatchObject({
      name: 'Full Set 2',
      kind: 'studio',
      forKind: 'design',
      subject: 'Subject for {{company}}',
      intro: 'First paragraph about {{company}}',
      body: '{{intro}} more text',
      note: 'when it fits',
      language: 'en',
      targetType: 'studio_named',
    });
  });

  it('a universal template is saved with an empty company type', async () => {
    const created = await createTemplate({ name: 'Universal', forKind: 'design' });
    expect((await updateTemplate(created.id, { forKind: null })).forKind).toBeNull();
  });

  it('archiving hides a template and brings it back', async () => {
    const created = await createTemplate({ name: 'One-off' });
    await archiveTemplate(created.id);
    expect((await getDb().select().from(templates).where(eq(templates.id, created.id)))[0]!.archived).toBe(true);

    await restoreTemplate(created.id);
    expect((await getDb().select().from(templates).where(eq(templates.id, created.id)))[0]!.archived).toBe(false);
  });

  it('deleting erases the template, but the outreach history stays readable', async () => {
    const created = await createTemplate({ name: 'To Delete' });
    const companyId = await companyForOutreach('delete-me.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    const result = await deleteTemplate(created.id);
    expect(result.keptInHistory).toBe(1);

    const rows = await getDb().select().from(templates).where(eq(templates.id, created.id));
    expect(rows).toHaveLength(0);

    // The key in outreach is a snapshot taken at the time of the letter, so it survives the template's deletion.
    const history = await getDb().select().from(outreach).where(eq(outreach.companyId, companyId));
    expect(history[0]!.templateUsed).toBe(created.slug);
  });

  it('a deleted starter template does not come back the next time the page opens', async () => {
    await seedTemplates();
    const [seeded] = await getDb().select().from(templates).where(eq(templates.slug, 'referral'));
    await deleteTemplate(seeded!.id);

    expect(await seedTemplates()).toBe(0);
    expect(await getDb().select().from(templates).where(eq(templates.slug, 'referral'))).toHaveLength(0);
  });

  it('renaming the key rewrites the outreach history to the new key', async () => {
    const created = await createTemplate({ name: 'Old Key' });
    const companyId = await companyForOutreach('rename-me.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    // The slug function keeps Cyrillic letters as is (only lowercasing and joining with
    // underscores), which matters for templates the owner writes in Ukrainian.
    const renamed = await updateTemplate(created.id, { slug: 'Новий Ключ 2' });
    expect(renamed.slug).toBe('новий_ключ_2');

    const history = await getDb().select().from(outreach).where(eq(outreach.companyId, companyId));
    expect(history[0]!.templateUsed).toBe('новий_ключ_2');
  });

  it('a taken key gets a suffix instead of an error', async () => {
    const first = await createTemplate({ name: 'Same Name' });
    const second = await createTemplate({ name: 'Same Name' });
    expect(second.slug).toBe(`${first.slug}_2`);
  });

  it('a duplicate is a separate template with its own key and the same text', async () => {
    const created = await createTemplate({ name: 'Original', kind: 'studio', body: 'letter text' });
    const copy = await duplicateTemplate(created.id);

    expect(copy.id).not.toBe(created.id);
    expect(copy.slug).not.toBe(created.slug);
    expect(copy.body).toBe('letter text');
    expect(copy.kind).toBe('studio');
  });

  it('the list shows how many letters were written with each template', async () => {
    const created = await createTemplate({ name: 'Active' });
    const companyId = await companyForOutreach('usage.com');
    await getDb().insert(outreach).values({ companyId, channel: 'email', templateUsed: created.slug });

    const row = (await listTemplates()).find((item) => item.id === created.id);
    expect(row!.usageCount).toBe(1);
  });

  it('a template can be tied to a company type and untied again', async () => {
    const created = await createTemplate({ name: 'For Design', kind: 'studio', forKind: 'design' });
    expect(created.forKind).toBe('design');

    const universal = await updateTemplate(created.id, { forKind: null });
    expect(universal.forKind).toBeNull();
  });

  it('without a tie, a template is universal', async () => {
    expect((await createTemplate({ name: 'Universal' })).forKind).toBeNull();
  });

  it('filtering by type returns only its own kind', async () => {
    await seedTemplates();
    const studio = await listTemplates('studio');
    expect(studio.length).toBeGreaterThan(0);
    expect(studio.every((row) => row.kind === 'studio')).toBe(true);
  });
});
