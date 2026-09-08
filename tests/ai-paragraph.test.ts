import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { facts } from '../src/db/schema.js';
import {
  buildPrompt,
  coinedTokens,
  companyFacts,
  generateParagraph,
  validateParagraph,
  type ParagraphResponse,
  longestSharedRun,
} from '../src/pipeline/ai-paragraph.js';
import type { DraftCandidate } from '../src/pipeline/outreach.js';

/**
 * Валідатор це головна частина Етапу 4: модель пропонує, код вирішує. Кожен
 * випадок з розділу 11 OUTREACH.md має тест, бо вигаданий факт у холодному листі
 * помічає тільки одержувач, і рівно один раз.
 */

const candidate: DraftCandidate = {
  companyId: 1,
  company: 'Acme Studio',
  domain: 'acme.com',
  country: 'PL',
  city: 'Warsaw',
  kind: 'studio',
  sizeHint: '10-50',
  techHints: ['react', 'next.js'],
  tags: ['web design'],
  description: 'Acme Studio builds ecommerce sites for European brands.',
  vacancyId: null,
  vacancyTitle: null,
  vacancyStack: [],
  contact: null,
};

const source = JSON.stringify(companyFacts(candidate), null, 2);

function response(over: Partial<ParagraphResponse> = {}): ParagraphResponse {
  return {
    paragraph:
      'You build ecommerce work for brands out of Warsaw, and acme.com runs on react with next.js. That is the stack I work in day to day, which is why I am writing to you.',
    facts_used: ['react', 'next.js'],
    confidence: 80,
    ...over,
  };
}

beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
});

describe('вхідні дані', () => {
  it('віддає моделі тільки те, що вже є в базі', () => {
    expect(Object.keys(companyFacts(candidate))).toEqual([
      'name',
      'domain',
      'city',
      'country',
      'size',
      'tech_hints',
      'tags',
      'description',
      'vacancy_title',
      'vacancy_stack',
    ]);
  });

  it('опис обрізається, довший хвіст дає лише матеріал для фантазій', () => {
    const long = { ...candidate, description: 'a'.repeat(900) };
    expect(companyFacts(long).description).toHaveLength(400);
  });

  it('промпт несе мову і факти про власника', async () => {
    await getDb()
      .insert(facts)
      .values({ key: 'stack', textUk: 'React і Node', textEn: 'React and Node' });
    const prompt = buildPrompt('uk', ['React і Node']);
    expect(prompt).toContain('Мова: uk');
    expect(prompt).toContain('React і Node');
    expect(prompt).toContain('Одне-два речення');
    // Лист має бути перед очима моделі: без нього абзац виходить довідкою про компанію.
    expect(prompt).toContain('{{intro}}');
  });
});

describe('валідація абзацу', () => {
  it('нормальний абзац проходить', () => {
    expect(validateParagraph(response(), source).ok).toBe(true);
  });

  it('em dash не відкочує, а міняється комою', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds ecommerce sites — and the stack on acme.com is react with next.js. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.ok).toBe(true);
    expect(result.paragraph).not.toContain('—');
    expect(result.paragraph).toContain('sites, and');
  });

  it('вигадана назва компанії відкочує абзац', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio recently shipped a project for Nike, and the stack on acme.com is react with next.js. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Nike');
  });

  it('вигадане число відкочує абзац', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio has shipped 47 ecommerce sites for European brands, and the stack is react with next.js. That is close to my work.',
      }),
      source,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('47');
  });

  it('занадто довгий абзац відкочує', () => {
    const result = validateParagraph(
      response({ paragraph: `${'acme '.repeat(70)}.` }),
      source,
    );
    expect(result.reason).toContain('слів');
  });

  it('занадто короткий абзац теж відкочує', () => {
    expect(validateParagraph(response({ paragraph: 'acme.com. React.' }), source).ok).toBe(false);
  });

  it('чотири речення це вже не абзац', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds sites. The stack is react. The domain is acme.com. That is close to the work I do every single day right now.',
      }),
      source,
    );
    expect(result.reason).toContain('речень');
  });

  it('низька впевненість відкочує', () => {
    expect(validateParagraph(response({ confidence: 40 }), source).reason).toContain('впевненість');
  });

  it('стоп-слово відкочує', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'I am excited about Acme Studio and the ecommerce sites it builds for European brands with react. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.reason).toContain('excited');
  });

  it('знак оклику відкочує', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds ecommerce sites for European brands with react and next.js! That is close to the work I do every day right now.',
      }),
      source,
    );
    expect(result.reason).toContain('оклику');
  });

  it('конструкція not X but Y відкочує', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio is not just a studio but a product team, judging by acme.com and its react stack. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.reason).toContain('not X but Y');
  });

  it('перше слово речення не вважається вигаданою назвою', () => {
    expect(coinedTokens('Sites for brands. React is the stack.', 'sites brands react')).toEqual([]);
  });
});

describe('генерація', () => {
  it('невалідний JSON дає один ретрай, потім відкат', async () => {
    const caller = vi.fn().mockResolvedValue('вибачте, ось відповідь без json');
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(result.used).toBe(false);
    expect(result.paragraph).toBeNull();
  });

  it('валідна відповідь повертає текст і впевненість', async () => {
    const caller = vi.fn().mockResolvedValue(JSON.stringify(response()));
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(result).toMatchObject({ used: true, confidence: 80, reason: null });
    expect(result.paragraph).toContain('acme.com');
  });

  it('невдала валідація не ганяє модель удруге', async () => {
    const caller = vi.fn().mockResolvedValue(JSON.stringify(response({ confidence: 10 })));
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(caller).toHaveBeenCalledTimes(1);
    expect(result.used).toBe(false);
    expect(result.reason).toContain('впевненість');
  });

  it('markdown-огорожа знімається, а не ламає розбір', async () => {
    const caller = vi.fn().mockResolvedValue(`\`\`\`json\n${JSON.stringify(response())}\n\`\`\``);
    expect((await generateParagraph(candidate, 'en', {}, caller)).used).toBe(true);
  });
});

/*
 * Найчастіший брак це не вигадка, а переказ: абзац переписує опис компанії з
 * каталогу. Формально бездоганний, усі попередні перевірки проходить, а як лист
 * не працює, бо читач знає про себе більше, ніж написано в тому описі.
 */
describe('абзац, який виявився довідкою', () => {
  const source = JSON.stringify(companyFacts(candidate));

  it('без звертання до читача це не лист', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio is a development company in Warsaw that works on websites and interfaces. The team ships react and next.js work for clients.',
      }),
      source,
      { language: 'en' },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('не звертається');
  });

  it('переказ опису компанії відкочується', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds ecommerce sites for European brands, and you keep the stack on react. I work in the same stack day to day on client projects.',
      }),
      source,
      { language: 'en', description: candidate.description },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('переказ опису');
  });

  it('свій текст із тими самими фактами проходить', () => {
    const result = validateParagraph(response(), source, {
      language: 'en',
      description: candidate.description,
    });

    expect(result.ok).toBe(true);
  });

  it('спільний відрізок рахується словами, а не символами', () => {
    expect(longestSharedRun('builds ecommerce sites for brands', 'Acme builds ecommerce sites for brands.')).toBe(5);
    expect(longestSharedRun('нічого спільного', 'зовсім інший текст')).toBe(0);
    expect(longestSharedRun('будь-що', null)).toBe(0);
  });
});
