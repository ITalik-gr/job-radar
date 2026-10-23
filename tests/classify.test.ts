import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, setRuntimeEnv } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, leads, llmCache, llmUsage } from '../src/db/schema.js';
import { activeDecisionModel, decide, decisionKey } from '../src/lib/decide.js';
import { studioPage } from '../src/pipeline/studios.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  classifyCompanies,
  classifyLeads,
  companyQuestions,
  companyRecord,
  fitPercent,
  hasEnoughText,
  isDecisive,
} from '../src/pipeline/classify.js';

/* `company.json` is a recorded clef-flash answer to `companyQuestions()`, REST envelope included. */
const fixture = readFileSync('fixtures/clef/company.json', 'utf8');

type Body = { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria: unknown }> };

const calls: { url: string; body: Body }[] = [];
let answer: (body: Body) => unknown = () => JSON.parse(fixture);

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  setRuntimeEnv({
    CF_AI_ACCOUNT_ID: 'test-account',
    CF_AI_API_TOKEN: 'test-token',
    AI_GATEWAY_ID: '',
    CLEF_MODEL: '',
    WORKERS_AI_DAILY_CALL_LIMIT: '',
    LLM_DAILY_CALL_LIMIT: '1000',
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    calls.push({ url, body });
    return new Response(JSON.stringify(answer(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
beforeEach(() => {
  calls.length = 0;
  answer = () => JSON.parse(fixture);
});
afterAll(() => {
  vi.unstubAllGlobals();
  setRuntimeEnv({ CF_AI_ACCOUNT_ID: '', CF_AI_API_TOKEN: '', LLM_DAILY_CALL_LIMIT: '' });
});

/**
 * A Clef REST answer for whatever was asked. `p` is the picked option's probability, the rest goes
 * to one runner-up, so p 0.9 is decisive (0.9 against 0.1) and p 0.55 is not (0.55 against 0.45).
 */
function clef(picks: Record<string, { choice?: string; score?: number; p: number }>) {
  return (body: Body) => ({
    success: true,
    result: {
      model: 'clef-flash',
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const pick = picks[id]!;
          return [
            id,
            question.type === 'score'
              ? { type: 'score', score: pick.score, legend: {}, probabilities: {}, confidence: 0.5 }
              : {
                  type: 'choice',
                  choice: pick.choice,
                  probabilities: { [pick.choice!]: pick.p, runner_up: 1 - pick.p },
                  confidence: 0.3,
                },
          ];
        }),
      ),
      usage: { input_tokens: 300, output_tokens: 0 },
    },
  });
}

describe('decide', () => {
  it('calls clef-flash by its full id, names it short in the body, parses and caches', async () => {
    const questions = companyQuestions();
    const first = await decide({ name: 'Посмішка', description: 'стоматологія' }, questions);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef-flash');
    expect(calls[0]!.body.model).toBe('clef-flash');
    expect(first).toMatchObject({ source: 'model', model: '@cf/cloudflare/clef-flash' });
    expect(first.answers.industry).toMatchObject({ type: 'choice', choice: 'dental', confidence: 0.7261 });

    const again = await decide({ name: 'Посмішка', description: 'стоматологія' }, questions);
    expect(calls).toHaveLength(1);
    expect(again.source).toBe('cache');

    const [usage] = await getDb().select().from(llmUsage);
    expect(usage).toMatchObject({ calls: 1, inputTokens: 916 });
  });

  it('a skipped question is an error, not a quiet empty answer', async () => {
    answer = () => ({ success: true, result: { model: 'clef-flash', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } });
    await expect(decide({ name: 'X' }, companyQuestions())).rejects.toThrow(
      'skipped questions: industry, kind',
    );
  });

  it('a Workers AI error fails loudly', async () => {
    answer = () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    await expect(decide({ name: 'Y' }, companyQuestions())).rejects.toThrow('Authentication error');
  });
});

describe('what the model is asked', () => {
  it('the same two questions every time, from the configured lists', () => {
    expect(Object.keys(companyQuestions())).toEqual(['industry', 'kind']);
    const kinds = companyQuestions().kind as { criteria: Record<string, string> };
    // smb, ecommerce and public are set only by a source or the owner.
    expect(Object.keys(kinds.criteria)).not.toContain('smb');
  });

  it('empty fields are left out of the record, a name alone is not enough text', () => {
    const record = companyRecord({ name: 'Acme', domain: '', description: null, tags: [], sources: ['dou'], country: 'UA', city: null, sizeHint: null } as never);
    expect(record).toEqual({ name: 'Acme', sources: ['dou'], country: 'UA' });
    expect(hasEnoughText({ description: 'short', tags: [] })).toBe(false);
    expect(hasEnoughText({ description: null, tags: ['web development'] })).toBe(true);
  });

  it('decisive means likely and well ahead, Clef confidence aside', () => {
    const pick = (probabilities: Record<string, number>) => ({ type: 'choice' as const, choice: 'x', probabilities, confidence: 0.3 });
    // Recorded: catalog studios came back like this, a clear answer with confidence 0.32.
    expect(isDecisive(pick({ agency: 0.58, saas: 0.06, devtools: 0.05, ai: 0.04, other: 0.04 }))).toBe(true);
    // Recorded: Stripe as product 0.44 against startup 0.29, a real doubt.
    expect(isDecisive(pick({ product: 0.44, startup: 0.29 }))).toBe(false);
    // Recorded: a marketing agency as studio 0.50 against design 0.41.
    expect(isDecisive(pick({ studio: 0.5, design: 0.41 }))).toBe(false);
  });

  it('fit levels map onto 0 to 100', () => {
    expect(fitPercent(0, 4)).toBe(0);
    expect(fitPercent(3, 4)).toBe(100);
    expect(fitPercent(1.5, 4)).toBe(50);
  });
});

describe('classify run', () => {
  let clinicId = 0;
  let mysteryId = 0;

  beforeAll(async () => {
    const db = getDb();
    clinicId = (await upsertCompany({ name: 'Clinic', domain: 'clinic.example.ua', source: 'dou' })).company.id;
    await db.update(companies).set({ description: 'Стоматологічна клініка у Львові: імплантація, лікування, відбілювання' }).where(eq(companies.id, clinicId));
    mysteryId = (await upsertCompany({ name: 'Mystery', domain: 'mystery.example.com', source: 'dou' })).company.id;
    await db.update(companies).set({ description: 'We do many things for many people in many places around the world' }).where(eq(companies.id, mysteryId));
    // Nothing to read: never asked.
    await upsertCompany({ name: 'Bare', domain: 'bare.example.com', source: 'dou' });
    // A catalog studio: its industry follows from the segment, no model call.
    await upsertCompany({ name: 'Studio', domain: 'studio.example.com', source: 'clutch', tags: ['Web Development'] });
  });

  it('applies confident answers, leaves doubtful ones, never asks about a bare name', async () => {
    answer = (body) =>
      body.state.name === 'Clinic'
        ? clef({ industry: { choice: 'dental', p: 0.93 }, kind: { choice: 'other', p: 0.9 } })(body)
        : clef({ industry: { choice: 'saas', p: 0.4 }, kind: { choice: 'startup', p: 0.55 } })(body);

    const stats = await classifyCompanies({ limit: 10 });
    expect(stats).toMatchObject({ itemsFound: 2, decided: 2, industrySet: 1, kindSet: 0, industryFromKind: 1, unsure: 2, remaining: 0 });
    expect(calls.map((call) => call.body.state.name).sort()).toEqual(['Clinic', 'Mystery']);

    const db = getDb();
    const [clinic] = await db.select().from(companies).where(eq(companies.id, clinicId));
    // "other" is not a segment: the clinic stays unknown until a source or the owner sets smb.
    expect(clinic).toMatchObject({ industry: 'dental', kind: 'unknown' });
    const [mystery] = await db.select().from(companies).where(eq(companies.id, mysteryId));
    expect(mystery).toMatchObject({ industry: null, kind: 'unknown' });
  });

  it('a second run asks nothing: every input already has an answer', async () => {
    const stats = await classifyCompanies({ limit: 10 });
    expect(stats.itemsFound).toBe(0);
    expect(stats.fromCache).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('an answer cached earlier is re-applied without a model call', async () => {
    // Stands in for a threshold change: the cached answer for Mystery becomes decisive.
    const db = getDb();
    const [mystery] = await db.select().from(companies).where(eq(companies.id, mysteryId));
    const key = decisionKey(activeDecisionModel(), companyRecord(mystery!), companyQuestions());
    await db
      .update(llmCache)
      .set({
        response: {
          answers: {
            industry: { type: 'choice', choice: 'saas', probabilities: { saas: 0.8, other: 0.2 }, confidence: 0.5 },
            kind: { type: 'choice', choice: 'startup', probabilities: { startup: 0.85, product: 0.15 }, confidence: 0.6 },
          },
        },
      })
      .where(eq(llmCache.key, key));

    const stats = await classifyCompanies({ limit: 10 });
    expect(stats).toMatchObject({ fromCache: 1, decided: 0 });
    expect(calls).toHaveLength(0);
    const [after] = await db.select().from(companies).where(eq(companies.id, mysteryId));
    expect(after).toMatchObject({ industry: 'saas', kind: 'startup' });
  });

  it('tenders get a fit from 0 to 100, news items are not rated', async () => {
    const db = getDb();
    await db.insert(leads).values([
      { source: 'prozorro', externalId: 'UA-1', url: 'https://prozorro.gov.ua/tender/UA-1', title: 'Розробка веб-сайту управління освіти' },
      { source: 'prozorro', externalId: 'UA-2', url: 'https://prozorro.gov.ua/tender/UA-2', title: 'Продовження ліцензій антивірусу' },
      { source: 'ain', externalId: 'n-1', url: 'https://ain.ua/n-1', title: 'Стартап залучив $2 млн' },
    ]);
    answer = (body) => clef({ fit: { score: String(body.state.title).includes('веб-сайту') ? 3 : 0.4, p: 0.9 } })(body);

    const stats = await classifyLeads({ limit: 10 });
    expect(stats).toMatchObject({ itemsFound: 2, itemsNew: 2, remaining: 0 });
    const rows = await db.select({ id: leads.externalId, fit: leads.fit }).from(leads).orderBy(leads.id);
    expect(rows).toEqual([
      { id: 'UA-1', fit: 100 },
      { id: 'UA-2', fit: 13 },
      { id: 'n-1', fit: null },
    ]);
  });

  it('a tender rated under minLeadFit stops counting as demand in the score', async () => {
    const db = getDb();
    const owner = (await upsertCompany({ name: 'School board', domain: 'osvita.example.ua', source: 'prozorro' })).company.id;
    const reasonsFor = async () =>
      (await studioPage({ scope: 'all', limit: 100 })).cards
        .find((card) => card.companyId === owner)!
        .why.map((item) => item.reason);

    await db.update(leads).set({ companyId: owner }).where(eq(leads.externalId, 'UA-2'));
    expect((await reasonsFor()).some((reason) => reason.startsWith('open tender'))).toBe(false);

    await db.update(leads).set({ companyId: owner }).where(eq(leads.externalId, 'UA-1'));
    expect(await reasonsFor()).toContain('open tender: Розробка веб-сайту управління освіти');
  });
});
