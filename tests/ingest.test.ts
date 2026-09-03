import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { dedupeKey, mergeSources } from '../src/pipeline/dedupe.js';
import { closeMissing, ingestVacancies, queue } from '../src/pipeline/ingest.js';
import type { RawVacancy } from '../src/sources/registry.js';

const raw = (over: Partial<RawVacancy> = {}): RawVacancy => ({
  source: 'greenhouse',
  externalId: '1',
  url: 'https://acme.com/jobs/1',
  title: 'Senior Frontend Developer',
  rawText:
    'We are looking for a senior frontend developer. Stack: React, TypeScript, Next.js. Remote friendly, Anthropic API integrations, Stripe billing.',
  companyName: 'Acme',
  companyDomain: 'acme.com',
  location: 'Remote, Europe',
  remote: true,
  postedAt: Date.now(),
  ...over,
});

const llmReply = (over: Record<string, unknown> = {}) => ({
  caller: async () => ({
    text: JSON.stringify({
      is_vacancy: true,
      title: 'Senior Frontend Developer',
      stack: ['react', 'typescript', 'next.js'],
      seniority: 'senior',
      remote: true,
      location: 'Remote, Europe',
      salary_min: null,
      salary_max: null,
      currency: null,
      english_level_required: 'B2',
      relevance: 90,
      why: 'повний збіг зі стеком',
      ...over,
    }),
    inputTokens: 10,
    outputTokens: 5,
  }),
});

let acme: Company;

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
});

describe('dedupeKey', () => {
  it('домен, слаг назви і тиждень', () => {
    const key = dedupeKey({
      domain: 'https://www.Acme.com',
      title: 'Senior Frontend Developer',
      url: 'https://acme.com/jobs/1',
      firstSeen: new Date('2026-09-03T00:00:00Z'),
    });
    expect(key).toBe('acme.com|senior-frontend-developer|2026-W36');
  });

  it('однакова вакансія з різних джерел дає той самий ключ', () => {
    const a = dedupeKey({ domain: 'acme.com', title: 'Senior Frontend Developer', url: 'https://acme.com/jobs/1' });
    const b = dedupeKey({ domain: 'acme.com', title: 'Senior  Frontend  Developer', url: 'https://djinni.co/jobs/77' });
    expect(a).toBe(b);
  });

  it('джерела зливаються, а не затираються', () => {
    expect(mergeSources('greenhouse', 'djinni')).toBe('greenhouse,djinni');
    expect(mergeSources('greenhouse,djinni', 'djinni')).toBe('greenhouse,djinni');
  });
});

describe('ingestVacancies', () => {
  it('релевантна вакансія класифікується, скориться і пишеться', async () => {
    const stats = await ingestVacancies([raw()], llmReply(), acme);
    expect(stats.created).toBe(1);
    expect(stats.classified).toBe(1);

    const [row] = await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/1'));
    expect(row!.stack).toEqual(['react', 'typescript', 'next.js']);
    expect(row!.llmRelevance).toBe(90);
    expect(row!.score).toBeGreaterThanOrEqual(config.pipeline.scoreThreshold);
    expect(row!.isVacancy).toBe(true);
  });

  it('повторний прогін не дублює, а оновлює last_seen і джерело', async () => {
    const before = (await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/1')))[0]!;
    const stats = await ingestVacancies([raw({ source: 'djinni', url: 'https://djinni.co/jobs/77' })], llmReply(), acme);

    expect(stats.updated).toBe(1);
    expect(stats.created).toBe(0);

    const after = (await getDb().select().from(vacancies).where(eq(vacancies.id, before.id)))[0]!;
    expect(after.source).toBe('greenhouse,djinni');
    expect(after.lastSeen).toBeGreaterThanOrEqual(before.lastSeen);
  });

  it('стоп-слово ріже до моделі, запис лишається в базі зі -100', async () => {
    let called = false;
    const stats = await ingestVacancies(
      [raw({ title: 'Angular Developer', url: 'https://acme.com/jobs/2', externalId: '2' })],
      {
        caller: async () => {
          called = true;
          return { text: '{}', inputTokens: 0, outputTokens: 0 };
        },
      },
      acme,
    );

    expect(called).toBe(false);
    expect(stats.stopped).toBe(1);
    const [row] = await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/2'));
    expect(row!.score).toBe(-100);
  });

  it('короткий блок довантажується, і стоп-слово з опису теж ріже', async () => {
    let called = false;
    const stats = await ingestVacancies(
      [raw({ title: 'Developer', rawText: 'Join our team', url: 'https://acme.com/jobs/3', externalId: '3' })],
      {
        fetchDetail: async () => 'We are a .NET shop looking for a developer to maintain our C# services.',
        caller: async () => {
          called = true;
          return { text: '{}', inputTokens: 0, outputTokens: 0 };
        },
      },
      acme,
    );

    expect(stats.detailed).toBe(1);
    expect(stats.stopped).toBe(1);
    expect(called).toBe(false);
  });

  it('невалідна відповідь моделі дає needs_review, а не втрату запису', async () => {
    const stats = await ingestVacancies(
      [raw({ url: 'https://acme.com/jobs/4', externalId: '4', title: 'React Engineer' })],
      { caller: async () => ({ text: 'не json', inputTokens: 1, outputTokens: 1 }) },
      acme,
    );

    expect(stats.needsReview).toBe(1);
    const [row] = await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/4'));
    expect(row!.needsReview).toBe(true);
    expect(row!.isVacancy).toBeNull();
    expect(row!.score).toBeGreaterThan(0);
  });
});

describe('економія на моделі', () => {
  it('вакансію, яку відсіюють безкоштовні правила, у модель не шлемо', async () => {
    let called = false;
    const stats = await ingestVacancies(
      [
        raw({
          title: 'React Engineer, Platform',
          url: 'https://acme.com/jobs/geo',
          externalId: 'geo',
          location: 'San Francisco, hybrid',
        }),
      ],
      {
        caller: async () => {
          called = true;
          return { text: '{}', inputTokens: 0, outputTokens: 0 };
        },
      },
      acme,
    );

    expect(called).toBe(false);
    expect(stats.skippedByFilter).toBe(1);
    expect(stats.created).toBe(1);
  });

  it('нетехнічна роль теж не доходить до моделі', async () => {
    let called = false;
    await ingestVacancies(
      [raw({ title: 'Account Executive, EMEA', url: 'https://acme.com/jobs/ae', externalId: 'ae' })],
      {
        caller: async () => {
          called = true;
          return { text: '{}', inputTokens: 0, outputTokens: 0 };
        },
      },
      acme,
    );
    expect(called).toBe(false);
  });

  it('перспективна вакансія модель усе ж отримує', async () => {
    let called = false;
    await ingestVacancies(
      [
        raw({
          title: 'Frontend Engineer, Growth',
          url: 'https://acme.com/jobs/good',
          externalId: 'good',
          location: 'Remote, Europe',
        }),
      ],
      {
        caller: async () => {
          called = true;
          return {
            text: JSON.stringify({
              is_vacancy: true,
              title: 'Frontend Engineer, Growth',
              stack: ['react'],
              seniority: 'senior',
              remote: true,
              location: 'Remote, Europe',
              salary_min: null,
              salary_max: null,
              currency: null,
              english_level_required: null,
              relevance: 80,
              why: 'збіг',
            }),
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      },
      acme,
    );
    expect(called).toBe(true);
  });
});

describe('closeMissing', () => {
  it('зниклі вакансії закриваються, а не видаляються', async () => {
    const open = await getDb().select().from(vacancies).where(eq(vacancies.companyId, acme.id));
    const keep = open[0]!.dedupeKey;

    const closed = await closeMissing(acme.id, 'greenhouse', [keep]);
    expect(closed).toBe(open.length - 1);

    const rows = await getDb().select().from(vacancies).where(eq(vacancies.companyId, acme.id));
    expect(rows).toHaveLength(open.length);
    expect(rows.filter((r) => r.closedAt !== null)).toHaveLength(open.length - 1);
  });
});

describe('queue', () => {
  it('показує тільки відкриті вакансії вище порогу', async () => {
    const rows = await queue();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.score!).toBeGreaterThanOrEqual(config.pipeline.scoreThreshold);
  });

  it('компанія зі статусом contacted зникає з черги', async () => {
    await getDb()
      .update(companyState)
      .set({ status: 'contacted' })
      .where(eq(companyState.companyId, acme.id));

    expect(await queue()).toHaveLength(0);

    await getDb()
      .update(companyState)
      .set({ status: 'snoozed', snoozedUntil: Date.now() + 86_400_000 })
      .where(eq(companyState.companyId, acme.id));
    expect(await queue()).toHaveLength(0);

    await getDb()
      .update(companyState)
      .set({ status: 'new', snoozedUntil: null })
      .where(eq(companyState.companyId, acme.id));
    expect((await queue()).length).toBeGreaterThan(0);
  });

  it('ліміт карток на день дотримується', async () => {
    expect((await queue(1)).length).toBeLessThanOrEqual(1);
  });
});
