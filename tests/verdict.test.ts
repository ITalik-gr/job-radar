import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, contacts, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { seedOutreachTemplates } from '../src/pipeline/outreach.js';
import { buildSystem, collectCompany, companyVerdict } from '../src/pipeline/verdict.js';

/**
 * The company verdict. The model is stubbed here on purpose: what is tested is not what it
 * answers, but what the code does with the answer. That is where the bugs live that make the
 * button look like it works: a non-existent template key accepted silently, and an empty answer
 * that leaves the owner without even a fallback.
 */

let studio: Company;

function reply(body: Record<string, unknown>) {
  return async () => ({ text: JSON.stringify(body), inputTokens: 100, outputTokens: 50 });
}

const valid = {
  template_slug: 'send_studio_named_en',
  alternative_slug: null,
  language: 'en',
  confidence: 80,
  angle: 'They build headless commerce on Next.js',
  why: 'The stack matches and there is a named contact',
  risks: [],
  contact: 'Anna Koval',
  skip: false,
  skip_reason: null,
};

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  const db = getDb();
  await seedOutreachTemplates();

  studio = (await upsertCompany({ name: 'Acme Studio', domain: 'acme-verdict.com', source: 'test' })).company;
  await db
    .update(companies)
    .set({ kind: 'studio', country: 'PL', techHints: ['next.js', 'react'] })
    .where(eq(companies.id, studio.id));
  await db
    .insert(contacts)
    .values({ companyId: studio.id, name: 'Anna Koval', role: 'CTO', email: 'anna@acme-verdict.com' });
});

describe('collecting company data', () => {
  it('gives the model only what is in the database', async () => {
    const block = await collectCompany(studio.id);

    expect(block.domain).toBe('acme-verdict.com');
    expect(block.tech_hints).toEqual(expect.arrayContaining(['next.js', 'react']));
    expect(block.contacts[0]?.name).toBe('Anna Koval');
    expect(block.score_reasons.length).toBeGreaterThan(0);
  });
});

describe('system block', () => {
  /*
   * The prompt cache is a byte-for-byte match of the request start. So templates must land in
   * the system block in a stable order, otherwise every call costs full price instead of a
   * tenth, and the only way to notice is the bill.
   */
  it('is identical for identical templates', () => {
    const list = [
      { slug: 'b', name: 'B', kind: 'studio', for_kind: null, language: 'en', target_type: 'studio_named', note: null, body: 'Hi' },
      { slug: 'a', name: 'A', kind: 'studio', for_kind: null, language: 'en', target_type: 'studio_generic', note: null, body: 'Hello' },
    ];

    expect(buildSystem(list, ['fact'])).toBe(buildSystem([...list], ['fact']));
    expect(buildSystem(list, [])).toContain('studio_named');
  });
});

describe('company verdict', () => {
  it('accepts the model answer and keeps the deterministic choice alongside', async () => {
    const report = await companyVerdict(studio.id, { caller: reply(valid), skipCache: true });

    expect(report.source).toBe('llm');
    expect(report.verdict?.template_slug).toBe('send_studio_named_en');
    expect(report.error).toBeNull();
    // A company in Poland means English, and the code computes that, not the model.
    expect(report.language).toBe('en');
    expect(report.fallbackTarget).toBe('studio_named');
    expect(report.fallbackSlug).toBeTruthy();
  });

  /*
   * The model regularly invents a similar but non-existent key. Accepted silently, it would
   * lead to a template that does not exist, and the button would look like it works without working.
   */
  it('rejects a non-existent template key', async () => {
    const report = await companyVerdict(studio.id, {
      caller: reply({ ...valid, template_slug: 'send_studio_named_pl' }),
      skipCache: true,
    });

    expect(report.verdict).toBeNull();
    expect(report.source).toBe('invalid');
    expect(report.error).toContain('send_studio_named_pl');
    // The fallback stays: the owner is never left without an answer to "what to write with".
    expect(report.fallbackSlug).toBeTruthy();
  });

  it('invalid JSON does not break the button', async () => {
    const report = await companyVerdict(studio.id, {
      caller: async () => ({ text: 'sorry, I cannot', inputTokens: 10, outputTokens: 5 }),
      skipCache: true,
    });

    expect(report.verdict).toBeNull();
    expect(report.error).toBeTruthy();
  });

  /*
   * A second click on the same card should cost nothing. The cache key includes both the
   * templates and the company data, so a text edit or a found email gives a new verdict by
   * itself, without a separate "recompute" button.
   */
  it('a repeated call comes from cache and does not call the model', async () => {
    const first = await companyVerdict(studio.id, { caller: reply(valid), skipCache: true });
    expect(first.source).toBe('llm');

    let called = 0;
    const second = await companyVerdict(studio.id, {
      caller: async () => {
        called += 1;
        return reply(valid)();
      },
    });

    expect(second.source).toBe('cache');
    expect(second.verdict?.template_slug).toBe('send_studio_named_en');
    expect(called).toBe(0);
  });
});
