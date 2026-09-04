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
  why: 'react і typescript, віддалено',
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
  it('знімає markdown-огорожу і преамбулу', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Ось відповідь: {"a":2} готово')).toEqual({ a: 2 });
  });

  it('падає, якщо обʼєкта немає', () => {
    expect(() => extractJson('нічого')).toThrow();
  });
});

describe('classifyText', () => {
  it('валідна відповідь парситься і кешується', async () => {
    const first = await classifyText('текст вакансії', { caller: reply(JSON.stringify(VALID)) });
    expect(first.reason).toBe('llm');
    expect(first.classification!.title).toBe('Senior Frontend Developer');

    let calls = 0;
    const second = await classifyText('текст вакансії', {
      caller: async () => {
        calls += 1;
        return { text: '{}', inputTokens: 0, outputTokens: 0 };
      },
    });
    expect(second.reason).toBe('cache');
    expect(calls).toBe(0);
  });

  it('невалідний JSON дає рівно один ретрай, потім ручний перегляд', async () => {
    let calls = 0;
    const result = await classifyText('поганий текст', {
      caller: async () => {
        calls += 1;
        return { text: 'вибачте, не можу', inputTokens: 10, outputTokens: 5 };
      },
    });

    expect(calls).toBe(2);
    expect(result.classification).toBeNull();
    expect(result.reason).toBe('invalid');
    expect(result.needsReview).toBe(true);
  });

  it('другий ретрай рятує, якщо модель виправилась', async () => {
    let calls = 0;
    const result = await classifyText('текст 2', {
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

  it('відповідь поза схемою не приймається', async () => {
    const result = await classifyText('текст 3', {
      caller: reply(JSON.stringify({ ...VALID, relevance: 900 })),
    });
    expect(result.classification).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  it('денний ліміт зупиняє виклики і не мовчить', async () => {
    await getDb().insert(llmUsage).values({ day: today(), calls: config.llm.dailyCallLimit });
    expect(await remainingBudget()).toBe(0);

    let calls = 0;
    const result = await classifyText('текст 4', {
      caller: async () => {
        calls += 1;
        return { text: JSON.stringify(VALID), inputTokens: 1, outputTokens: 1 };
      },
    });

    expect(calls).toBe(0);
    expect(result.reason).toBe('budget');
    expect(result.needsReview).toBe(true);
  });

  it('лічильник токенів і викликів росте', async () => {
    await classifyText('текст 5', { caller: reply(JSON.stringify(VALID)) });
    const [row] = await getDb().select().from(llmUsage).where(eq(llmUsage.day, today()));
    expect(row!.calls).toBe(1);
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(50);
  });

  it('падіння мережі рахується як помилка і теж їсть ретрай', async () => {
    const result = await classifyText('текст 6', {
      caller: async () => {
        throw new Error('503 overloaded');
      },
    });
    expect(result.reason).toBe('invalid');
    const [row] = await getDb().select().from(llmUsage).where(eq(llmUsage.day, today()));
    expect(row!.failures).toBe(2);
  });

  /*
   * Кеш ключується моделлю, а не лише текстом. Без цього перемикання на Workers AI
   * мовчки віддавало б класифікації Haiku, і зміну провайдера не було б видно взагалі.
   */
  it('стеля викликів у Workers AI своя, бо це квота плану, а не рахунок', () => {
    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
    const paid = config.llm.dailyCallLimit;

    setRuntimeEnv({ LLM_PROVIDER: 'workers-ai' });
    expect(config.llm.dailyCallLimit).toBeGreaterThan(paid);

    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
  });

  it('ключ кешу різний у Anthropic і Workers AI', () => {
    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
    const anthropicKey = cacheKey('той самий текст');

    setRuntimeEnv({ LLM_PROVIDER: 'workers-ai' });
    expect(config.llm.activeModel).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(cacheKey('той самий текст')).not.toBe(anthropicKey);

    setRuntimeEnv({ LLM_PROVIDER: 'anthropic' });
  });
});
