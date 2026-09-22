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
 * The validator is the core of this module: the model proposes, the code decides. Every case
 * from section 11 of OUTREACH.md has a test, because a made-up fact in a cold letter is noticed
 * only by the recipient, and exactly once.
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

describe('input', () => {
  it('gives the model only what the database already has', () => {
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

  it('the description is cut, a longer tail only feeds invention', () => {
    const long = { ...candidate, description: 'a'.repeat(900) };
    expect(companyFacts(long).description).toHaveLength(400);
  });

  it('the prompt carries the language and the owner facts', async () => {
    await getDb()
      .insert(facts)
      .values({ key: 'stack', textUk: 'React і Node', textEn: 'React and Node' });
    const prompt = buildPrompt('uk', ['React і Node']);
    expect(prompt).toContain('Language: uk');
    expect(prompt).toContain('React і Node');
    expect(prompt).toContain('One or two sentences');
    // The letter has to be in front of the model: without it the paragraph comes out as a reference entry.
    expect(prompt).toContain('{{intro}}');
  });
});

describe('paragraph validation', () => {
  it('a normal paragraph passes', () => {
    expect(validateParagraph(response(), source).ok).toBe(true);
  });

  it('an em dash does not cause a fallback, it becomes a comma', () => {
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

  it('an invented company name causes a fallback', () => {
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

  it('an invented number causes a fallback', () => {
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

  it('a paragraph that is too long falls back', () => {
    const result = validateParagraph(
      response({ paragraph: `${'acme '.repeat(70)}.` }),
      source,
    );
    expect(result.reason).toContain('words');
  });

  it('a paragraph that is too short falls back too', () => {
    expect(validateParagraph(response({ paragraph: 'acme.com. React.' }), source).ok).toBe(false);
  });

  it('four sentences are no longer a paragraph', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds sites. The stack is react. The domain is acme.com. That is close to the work I do every single day right now.',
      }),
      source,
    );
    expect(result.reason).toContain('sentences');
  });

  it('low confidence falls back', () => {
    expect(validateParagraph(response({ confidence: 40 }), source).reason).toContain('confidence');
  });

  it('a stop word falls back', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'I am excited about Acme Studio and the ecommerce sites it builds for European brands with react. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.reason).toContain('excited');
  });

  it('an exclamation mark falls back', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds ecommerce sites for European brands with react and next.js! That is close to the work I do every day right now.',
      }),
      source,
    );
    expect(result.reason).toContain('exclamation');
  });

  it('a not X but Y construction falls back', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio is not just a studio but a product team, judging by acme.com and its react stack. That is close to the work I do right now.',
      }),
      source,
    );
    expect(result.reason).toContain('not X but Y');
  });

  it('the first word of a sentence is not treated as an invented name', () => {
    expect(coinedTokens('Sites for brands. React is the stack.', 'sites brands react')).toEqual([]);
  });
});

describe('generation', () => {
  it('invalid JSON gets one retry, then a fallback', async () => {
    const caller = vi.fn().mockResolvedValue('sorry, here is an answer without json');
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(result.used).toBe(false);
    expect(result.paragraph).toBeNull();
  });

  it('a valid response returns the text and the confidence', async () => {
    const caller = vi.fn().mockResolvedValue(JSON.stringify(response()));
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(result).toMatchObject({ used: true, confidence: 80, reason: null });
    expect(result.paragraph).toContain('acme.com');
  });

  it('failed validation does not run the model again', async () => {
    const caller = vi.fn().mockResolvedValue(JSON.stringify(response({ confidence: 10 })));
    const result = await generateParagraph(candidate, 'en', {}, caller);
    expect(caller).toHaveBeenCalledTimes(1);
    expect(result.used).toBe(false);
    expect(result.reason).toContain('confidence');
  });

  it('a markdown fence is stripped rather than breaking parsing', async () => {
    const caller = vi.fn().mockResolvedValue(`\`\`\`json\n${JSON.stringify(response())}\n\`\`\``);
    expect((await generateParagraph(candidate, 'en', {}, caller)).used).toBe(true);
  });
});

/*
 * The most common defect is not invention but retelling: the paragraph copies the catalog
 * description of the company. Formally flawless, passes every earlier check, and does not work
 * as a letter, because the reader knows more about themselves than that description says.
 */
describe('a paragraph that turned out to be a reference entry', () => {
  const source = JSON.stringify(companyFacts(candidate));

  it('without addressing the reader it is not a letter', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio is a development company in Warsaw that works on websites and interfaces. The team ships react and next.js work for clients.',
      }),
      source,
      { language: 'en' },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not address');
  });

  it('retelling the company description falls back', () => {
    const result = validateParagraph(
      response({
        paragraph:
          'Acme Studio builds ecommerce sites for European brands, and you keep the stack on react. I work in the same stack day to day on client projects.',
      }),
      source,
      { language: 'en', description: candidate.description },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('retells the company description');
  });

  it('own text with the same facts passes', () => {
    const result = validateParagraph(response(), source, {
      language: 'en',
      description: candidate.description,
    });

    expect(result.ok).toBe(true);
  });

  it('the shared run is counted in words, not characters', () => {
    expect(longestSharedRun('builds ecommerce sites for brands', 'Acme builds ecommerce sites for brands.')).toBe(5);
    expect(longestSharedRun('nothing in common', 'a completely different text')).toBe(0);
    expect(longestSharedRun('anything', null)).toBe(0);
  });
});
