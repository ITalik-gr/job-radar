import { describe, expect, it } from 'vitest';
import type { Company } from '../src/db/schema.js';
import type { Answer } from '../src/lib/decide.js';
import { scoreCompany } from '../src/pipeline/company-score.js';
import { fitLevel, fitPatch, fitQuestions, fitRecord } from '../src/pipeline/fit.js';
import fitConfig from '../config/fit.json' with { type: 'json' };

/*
 * Lead fit is three picks from fixed lists. What matters here: the stored number maps back to the
 * level the score weighs, an unsure service or stage is not stored as a fact, and the record the
 * model reads holds only what is known.
 */

const choice = (picked: string, probabilities: Record<string, number>): Answer => ({
  type: 'choice',
  choice: picked,
  probabilities,
  confidence: 0.5,
});

const startup = {
  id: 7,
  name: 'Rocket AI',
  domain: 'rocket.ai',
  country: 'US',
  city: null,
  sizeHint: '1 - 9',
  kind: 'startup',
  industry: 'ai',
  description: 'An AI assistant for small accounting firms, two founders, launched in spring.',
  tags: ['SaaS'],
  sources: ['yc'],
  techHints: [],
  hiringDevs: false,
  foundedYear: null,
  fit: null,
} as unknown as Company;

describe('lead fit', () => {
  it('asks the buyer level, the service and the stage from the config lists', () => {
    const questions = fitQuestions();
    expect(Object.keys(questions)).toEqual(['buyer', 'service', 'stage']);
    expect(questions.buyer).toMatchObject({ type: 'score', criteria: fitConfig.buyer });
    expect(Object.keys((questions.service as { criteria: Record<string, string> }).criteria)).toContain('mvp');
  });

  it('a level index round trips through the stored 0 to 100', () => {
    expect(fitLevel(null)).toBeNull();
    expect(fitLevel(0)).toBe('no');
    expect(fitLevel(33)).toBe('unlikely');
    expect(fitLevel(67)).toBe('possible');
    expect(fitLevel(100)).toBe('likely');
  });

  it('stores the level always, the service and stage only when decisive', () => {
    const now = 1_000;
    const sure = fitPatch(
      {
        buyer: { type: 'score', score: 3, probabilities: {}, confidence: 0.8 },
        service: choice('mvp', { mvp: 0.8, website: 0.1 }),
        stage: choice('early', { early: 0.7, idea: 0.2 }),
      },
      now,
    );
    expect(sure).toEqual({ fit: 100, fitService: 'mvp', fitStage: 'early', fitAt: now });

    const unsure = fitPatch(
      {
        buyer: { type: 'score', score: 1, probabilities: {}, confidence: 0.4 },
        service: choice('ai', { ai: 0.45, mvp: 0.4 }),
        stage: choice('unknown', { unknown: 0.9 }),
      },
      now,
    );
    expect(unsure).toEqual({ fit: 33, fitService: null, fitStage: null, fitAt: now });
  });

  it('the record carries what is known and leaves the rest out', () => {
    const record = fitRecord(startup);
    expect(record).toMatchObject({ name: 'Rocket AI', segment: 'startup', industry: 'ai' });
    expect(record).not.toHaveProperty('site_stack');
    expect(record).not.toHaveProperty('hiring_developers');
  });

  it('the score weighs the level, and an unrated company gets nothing', () => {
    const reasons = (fit: number | null) => {
      const breakdown = scoreCompany({ company: { ...startup, fit } as Company, now: 0 });
      return [...breakdown.positives, ...breakdown.negatives].filter((item) => item.reason.startsWith('model fit'));
    };
    expect(reasons(null)).toEqual([]);
    expect(reasons(100)).toEqual([{ reason: 'model fit: likely', weight: 4 }]);
    expect(reasons(0)).toEqual([{ reason: 'model fit: no', weight: -8 }]);
  });
});
