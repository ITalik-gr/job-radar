import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { llmCache, llmUsage } from '../src/db/schema.js';
import { cacheKey, classifyText, extractJson, remainingBudget, today } from '../src/pipeline/classify.js';
import { setRuntimeEnv } from '../src/config.js';

const VALID = {
  is_vacancy: true,
  title: 'Senior Frontend Developer',
  stack: ['react', 'typescript'],
  seniority: 'senior',
  remote: true,
  location: 'Berlin, hybrid',
  salary_min: null,
  salary_max: null,
  currency: null,
  english_level_required: 'B2',
  relevance: 80,
  why: 'react і typescript, віддалено', // LLM answers "why" in Ukrainian per the classify.ts prompt spec
};

const reply = (text: string) => async () => ({ text, inputTokens: 100, outputTokens: 50 });

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

beforeEach(async () => {
  await getDb().delete(llmCache);
  await getDb().delete(llmUsage);
});

describe('extractJson', () => {
  it('strips a markdown fence and a preamble', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here is the answer: {"a":2} done')).toEqual({ a: 2 });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('nothing')).toThrow();
  });
});

describe('classifyText', () => {
  it('a valid response is parsed and cached', async () => {
    const first = await classifyText('vacancy text', { caller: reply(JSON.stringify(VALID)) });
    expect(first.reason).toBe('llm');
    expect(first.classification!.title).toBe('Senior Frontend Developer');

    let calls = 0;
    const second = await classifyText('vacancy text', {
      caller: async () => {
        calls += 1;
        return { text: '{}', inputTokens: 0, outputTokens: 0 };
      },
    });
    expect(second.reason).toBe('cache');
    expect(calls).toBe(0);
  });

  it('invalid JSON gets exactly one retry, then goes to manual review', async () => {
    let calls = 0;
    const result = await classifyText('bad text', {
      caller: async () => {
        calls += 1;
        return { text: 'sorry, I cannot', inputTokens: 10, outputTokens: 5 };
      },
    });

    expect(calls).toBe(2);
    expect(result.classification).toBeNull();
    expect(result.reason).toBe('invalid');
    expect(result.needsReview).toBe(true);
  });

  it('the second retry saves the day if the model corrects itself', async () => {
    let calls = 0;
    const result = await classifyText('text 2', {
      caller: async () => {
        calls += 1;
        return calls === 1
          ? { text: 'not json', inputTokens: 10, outputTokens: 5 }
          : { text: JSON.stringify(VALID), inputTokens: 10, outputTokens: 5 };
      },
    });
    expect(result.classification).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('a response outside the schema is not accepted', async () => {
    const result = await classifyText('text 3', {
      caller: reply(JSON.stringify({ ...VALID, relevance: 900 })),
    });
    expect(result.classification).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  it('the daily limit stops calls and does not stay silent', async () => {
    await getDb().insert(llmUsage).values({ day: today(), calls: config.llm.dailyCallLimit });
    expect(await remainingBudget()).toBe(0);

    let calls = 0;
    const result = await classifyText('text 4', {
      caller: async () => {
        calls += 1;
        return { text: JSON.stringify(VALID), inputTokens: 1, outputTokens: 1 };
      },
    });

    expect(calls).toBe(0);
    expect(result.reason).toBe('budget');
    expect(result.needsReview).toBe(true);
  });

  it('the token and call counters grow', async () => {
    await classifyText('text 5', { caller: reply(JSON.stringify(VALID)) });
    const [row] = await getDb().select().from(llmUsage).where(eq(llmUsage.day, today()));
    expect(row!.calls).toBe(1);
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(50);
  });

  it('a network failure counts as an error and also eats a retry', async () => {
    const result = await classifyText('text 6', {
      caller: async () => {
        throw new Error('503 overloaded');
      },
    });
    expect(result.reason).toBe('invalid');
    const [row] = await getDb().select().from(llmUsage).where(eq(llmUsage.day, today()));
    expect(row!.failures).toBe(2);
  });

  /*
   * The cache is keyed by model, not just by text. Without this, switching to Workers AI
   * would silently keep returning Haiku classifications, and the provider change would
   * be invisible altogether.
   */
  it('the call ceiling on Workers AI is its own, since it is a plan quota, not a bill', () => {
    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
    const paid = config.llm.dailyCallLimit;

    setRuntimeEnv({ LLM_PROVIDER: 'workers-ai' });
    expect(config.llm.dailyCallLimit).toBeGreaterThan(paid);

    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
  });

  it('the cache key differs between Anthropic and Workers AI', () => {
    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
    const anthropicKey = cacheKey('the same text');

    setRuntimeEnv({ LLM_PROVIDER: 'workers-ai' });
    expect(config.llm.activeModel).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(cacheKey('the same text')).not.toBe(anthropicKey);

    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
  });
});
