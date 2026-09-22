import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, companyState, vacancies, type Company } from '../src/db/schema.js';
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
      why: 'full match with the stack',
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

describe('unknown company', () => {
  it('a vacancy with a name and domain creates the company instead of being dropped', async () => {
    /*
     * Such a record used to silently disappear in the debug log. That was eating the whole
     * output of sources that bring new companies together with vacancies: accelerator boards,
     * DOU, Djinni.
     */
    const before = await getDb().select().from(companies);

    await ingestVacancies(
      [
        {
          source: 'getro',
          externalId: 'new-1',
          url: 'https://jobs.example.com/companies/newco/jobs/1',
          title: 'Frontend Engineer',
          rawText: 'react typescript next.js remote',
          companyName: 'NewCo',
          companyDomain: 'newco.dev',
          location: 'Remote',
          remote: true,
          postedAt: null,
        },
      ],
      { skipLlm: true },
    );

    const after = await getDb().select().from(companies);
    expect(after.length).toBe(before.length + 1);
    expect(after.some((row) => row.domain === 'newco.dev')).toBe(true);

    // Clean up after ourselves: the test file shares one database, and a stray
    // vacancy above the threshold would break the queue checks below.
    await getDb().delete(companies).where(eq(companies.domain, 'newco.dev'));
  });

  it('without a domain the company is not invented: otherwise all vacancies from a board would become one', async () => {
    const before = await getDb().select().from(companies);

    await ingestVacancies(
      [
        {
          source: 'djinni',
          externalId: 'anon-1',
          url: 'https://djinni.co/jobs/999-frontend/',
          title: 'Frontend Developer',
          rawText: 'react typescript',
          companyName: 'Hidden Company',
          companyDomain: null,
          location: 'Kyiv',
          remote: false,
          postedAt: null,
        },
      ],
      { skipLlm: true },
    );

    expect((await getDb().select().from(companies)).length).toBe(before.length);
  });
});

describe('dedupeKey', () => {
  it('domain, title slug and week', () => {
    const key = dedupeKey({
      domain: 'https://www.Acme.com',
      title: 'Senior Frontend Developer',
      url: 'https://acme.com/jobs/1',
      firstSeen: new Date('2026-09-03T00:00:00Z'),
    });
    expect(key).toBe('acme.com|senior-frontend-developer|2026-W36');
  });

  it('the same vacancy from different sources gives the same key', () => {
    const a = dedupeKey({ domain: 'acme.com', title: 'Senior Frontend Developer', url: 'https://acme.com/jobs/1' });
    const b = dedupeKey({ domain: 'acme.com', title: 'Senior  Frontend  Developer', url: 'https://djinni.co/jobs/77' });
    expect(a).toBe(b);
  });

  it('sources merge instead of being overwritten', () => {
    expect(mergeSources('greenhouse', 'djinni')).toBe('greenhouse,djinni');
    expect(mergeSources('greenhouse,djinni', 'djinni')).toBe('greenhouse,djinni');
  });
});

describe('ingestVacancies', () => {
  it('a relevant vacancy gets classified, scored and written', async () => {
    const stats = await ingestVacancies([raw()], llmReply(), acme);
    expect(stats.created).toBe(1);
    expect(stats.classified).toBe(1);

    const [row] = await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/1'));
    expect(row!.stack).toEqual(['react', 'typescript', 'next.js']);
    expect(row!.llmRelevance).toBe(90);
    expect(row!.score).toBeGreaterThanOrEqual(config.pipeline.scoreThreshold);
    expect(row!.isVacancy).toBe(true);
  });

  it('a repeat run does not duplicate, it updates last_seen and the source', async () => {
    const before = (await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/1')))[0]!;
    const stats = await ingestVacancies([raw({ source: 'djinni', url: 'https://djinni.co/jobs/77' })], llmReply(), acme);

    expect(stats.updated).toBe(1);
    expect(stats.created).toBe(0);

    const after = (await getDb().select().from(vacancies).where(eq(vacancies.id, before.id)))[0]!;
    expect(after.source).toBe('greenhouse,djinni');
    expect(after.lastSeen).toBeGreaterThanOrEqual(before.lastSeen);
  });

  it('a stop word cuts before the model, the record stays in the database with -100', async () => {
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

  it('a short block gets fetched in full, and a stop word in the description also cuts', async () => {
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

  it('an invalid model reply gives needs_review, not a lost record', async () => {
    const stats = await ingestVacancies(
      [raw({ url: 'https://acme.com/jobs/4', externalId: '4', title: 'React Engineer' })],
      { caller: async () => ({ text: 'not json', inputTokens: 1, outputTokens: 1 }) },
      acme,
    );

    expect(stats.needsReview).toBe(1);
    const [row] = await getDb().select().from(vacancies).where(eq(vacancies.url, 'https://acme.com/jobs/4'));
    expect(row!.needsReview).toBe(true);
    expect(row!.isVacancy).toBeNull();
    expect(row!.score).toBeGreaterThan(0);
  });
});

describe('saving on the model', () => {
  it('a vacancy filtered out by the free rules is not sent to the model', async () => {
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

  it('a non technical role also does not reach the model', async () => {
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

  it('a promising vacancy still reaches the model', async () => {
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
              why: 'match',
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
  it('missing vacancies get closed, not deleted', async () => {
    const open = await getDb().select().from(vacancies).where(eq(vacancies.companyId, acme.id));
    const keep = open[0]!.dedupeKey;

    const closed = await closeMissing(acme.id, 'greenhouse', [keep]);
    expect(closed).toBe(open.length - 1);

    const rows = await getDb().select().from(vacancies).where(eq(vacancies.companyId, acme.id));
    expect(rows).toHaveLength(open.length);
    expect(rows.filter((r) => r.closedAt !== null)).toHaveLength(open.length - 1);
  });

  /*
   * Batches exist because of D1's limit on a hundred bound parameters. The test takes a number
   * that is guaranteed to span several batches: in a single request this would fail on Workers,
   * and that is exactly how it failed on Greenhouse boards for large companies.
   */
  it('closes hundreds of vacancies without hitting the query parameter limit', async () => {
    const { company } = await upsertCompany({ name: 'Bulk', domain: 'bulk-close.com', source: 'test' });
    const total = 250;

    await getDb()
      .insert(vacancies)
      .values(
        Array.from({ length: total }, (_, i) => ({
          companyId: company.id,
          source: 'greenhouse',
          externalId: String(i),
          url: `https://bulk-close.com/jobs/${i}`,
          title: `Frontend Developer ${i}`,
          dedupeKey: `bulk-close.com|frontend-developer-${i}|1`,
        })),
      );

    expect(await closeMissing(company.id, 'greenhouse', [])).toBe(total);

    const rows = await getDb().select().from(vacancies).where(eq(vacancies.companyId, company.id));
    expect(rows).toHaveLength(total);
    expect(rows.every((row) => row.closedAt !== null)).toBe(true);
  });
});

describe('queue', () => {
  it('shows only open vacancies above the threshold', async () => {
    const rows = await queue();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.score!).toBeGreaterThanOrEqual(config.pipeline.scoreThreshold);
  });

  it('a company with contacted status drops out of the queue', async () => {
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

  it('the daily card limit is respected', async () => {
    expect((await queue(1)).length).toBeLessThanOrEqual(1);
  });
});
