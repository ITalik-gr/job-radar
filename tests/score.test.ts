import { describe, expect, it } from 'vitest';
import {
  findStopWords,
  geoFits,
  hasStopWord,
  requiredYears,
  roleFits,
  scoreVacancy,
} from '../src/pipeline/score.js';
import { loadRules } from '../src/pipeline/rules.js';

const vacancy = (over: Partial<Parameters<typeof scoreVacancy>[0]> = {}) =>
  scoreVacancy({ title: 'Senior Frontend Developer', text: 'react typescript next.js', ...over });

describe('config', () => {
  it('gambling, adult and forex are no longer filtered out', () => {
    const rules = loadRules();
    for (const word of ['gambling', 'betting', 'casino', 'adult', 'forex']) {
      expect(rules.stopWords).not.toContain(word);
    }
  });

  it('config/scoring.json is valid and has every section', () => {
    const rules = loadRules();
    expect(rules.stopWords).toContain('angular');
    expect(rules.geo.blockedRegions).toContain('san francisco');
    expect(rules.weights.terms['react']).toBe(3);
    expect(rules.companies.sizeWeights['10 - 49']).toBe(5);
  });
});

describe('stop words', () => {
  it('catch foreign technologies without touching similar words', () => {
    expect(findStopWords('Senior Angular Developer')).toEqual(['angular']);
    expect(hasStopWord('We need a .NET and C# engineer')).toBe(true);
    expect(findStopWords('React developer with Node')).toEqual([]);
    expect(findStopWords('we use nextjs and dotnetify-like tools')).toEqual([]);
  });
});

describe('role by title', () => {
  it('lets engineering titles through', () => {
    expect(roleFits('Senior Frontend Developer').ok).toBe(true);
    expect(roleFits('Full-Stack Engineer, AI').ok).toBe(true);
    expect(roleFits('Розробник React').ok).toBe(true);
  });

  it('cuts non-technical roles even when the description is full of stack', () => {
    expect(roleFits('Sr. Manager, Accounting (India)').ok).toBe(false);
    expect(roleFits('Account Executive, Commercial').ok).toBe(false);
    expect(roleFits('Developer Relations Engineer').ok).toBe(false);
    expect(roleFits('Product Manager').ok).toBe(false);
  });

  it('an accountant at a company describing Next.js gets -100, not 7 points', () => {
    const result = vacancy({
      title: 'Sr. Manager, Accounting (India)',
      text: 'About Vercel: the team behind Next.js, v0, and AI SDK. React, TypeScript everywhere.',
    });
    expect(result.score).toBe(-100);
    expect(result.rejectedBy).toContain('wrong role');
  });
});

describe('geo', () => {
  it('remote tied to the US does not fit', () => {
    const verdict = geoFits('Remote, United States');
    expect(verdict.eligible).toBe(false);
    expect(verdict.weight).toBeLessThan(0);
  });

  it('hybrid in San Francisco does not fit, even with the remote flag set', () => {
    const result = vacancy({ location: 'San Francisco, hybrid', remote: true });
    expect(result.rejectedBy).toContain('geo');
    expect(result.score).toBeLessThan(6);
  });

  it('Europe, worldwide and anywhere fit', () => {
    expect(geoFits('Remote, Europe').eligible).toBe(true);
    expect(geoFits('Worldwide').eligible).toBe(true);
    expect(geoFits('Remote, Global').eligible).toBe(true);
  });

  it('Kyiv and Ukraine give a bonus', () => {
    const verdict = geoFits('Kyiv, hybrid');
    expect(verdict.eligible).toBe(true);
    expect(verdict.weight).toBeGreaterThan(0);
  });

  it('a restriction in the text is caught when the location looks neutral', () => {
    const verdict = geoFits('Remote', 'You must be located in the United States to apply.');
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain('must be located in');
  });

  it('a vacancy without any region is not penalised', () => {
    expect(geoFits('Remote').eligible).toBe(true);
    expect(geoFits(null).eligible).toBe(true);
  });
});

describe('experience', () => {
  it('extracts the largest years requirement from the text', () => {
    expect(requiredYears('3+ years of experience')).toBe(3);
    expect(requiredYears('5+ years building web apps')).toBe(5);
    expect(requiredYears('at least 7 years, ideally 10 years')).toBe(10);
    expect(requiredYears('no numbers here')).toBeNull();
  });

  it('5+ years is a noticeable minus, 7+ a much bigger one', () => {
    const five = vacancy({ text: 'react typescript, 5+ years of experience' });
    const seven = vacancy({ text: 'react typescript, 7+ years of experience' });
    expect(five.negatives.some((item) => item.weight === -3)).toBe(true);
    expect(seven.negatives.some((item) => item.weight === -8)).toBe(true);
    expect(seven.score).toBeLessThan(five.score);
  });

  it('a lead title is penalised separately from years', () => {
    const result = vacancy({ title: 'Staff Frontend Engineer' });
    expect(result.negatives.some((item) => item.reason === 'lead position')).toBe(true);
  });
});

describe('technology points', () => {
  it('a match in the title weighs three times as much', () => {
    const inTitle = vacancy({ title: 'React Developer', text: 'we write in something' });
    expect(inTitle.positives.find((item) => item.reason.includes('react'))!.weight).toBe(9);
  });

  it('company text cannot push past the cap', () => {
    const result = vacancy({
      title: 'Web Developer',
      text: 'react typescript next.js nestjs cloudflare node stripe postgresql astro prisma tailwind llm claude openai anthropic',
    });
    const fromBody = result.positives
      .filter((item) => !item.reason.includes('in the title'))
      .reduce((sum, item) => sum + item.weight, 0);
    expect(fromBody).toBeLessThanOrEqual(8);
  });

  it('llm_relevance adds no more than five points', () => {
    const base = vacancy();
    const withLlm = vacancy({ llmRelevance: 100 });
    expect(withLlm.score - base.score).toBe(5);
  });
});

describe('company size', () => {
  it('a well-known large company gets a noticeable minus', () => {
    const big = vacancy({ companyDomain: 'stripe.com', location: 'Remote, Europe' });
    const small = vacancy({ companyDomain: 'tiny-studio.com', location: 'Remote, Europe' });
    expect(big.negatives.some((item) => item.reason === 'large well-known company')).toBe(true);
    expect(big.score).toBeLessThan(small.score);
  });

  it('size from a catalog counts too', () => {
    const huge = vacancy({ companySizeHint: '1,000 - 9,999', location: 'Remote, Europe' });
    const tiny = vacancy({ companySizeHint: '10 - 49', location: 'Remote, Europe' });
    expect(huge.score).toBeLessThan(tiny.score);
    expect(tiny.positives.some((item) => item.reason === 'small company')).toBe(true);
  });

  it('a giant clears the threshold only with a very strong match', () => {
    const weak = vacancy({
      title: 'Web Developer',
      text: 'react',
      companyDomain: 'stripe.com',
      location: 'Remote, Europe',
    });
    const strong = vacancy({
      title: 'Senior Full-Stack Engineer, React and Next.js',
      text: 'react, typescript, next.js, node, stripe, anthropic api, cloudflare workers',
      companyDomain: 'stripe.com',
      location: 'Remote, Europe',
      llmRelevance: 95,
    });
    expect(weak.score).toBeLessThan(6);
    expect(strong.score).toBeGreaterThanOrEqual(6);
  });
});

describe('vacancy in Ukrainian', () => {
  it('gets a bonus, because the interview will be in Ukrainian', () => {
    const ua = vacancy({
      title: 'Frontend розробник',
      text: 'Шукаємо розробника з досвідом React, обовʼязки: розробка інтерфейсів, команда 10 осіб',
    });
    expect(ua.positives.some((item) => item.reason === 'vacancy in Ukrainian')).toBe(true);
  });
});

describe('summary', () => {
  it('a relevant remote European vacancy clears the threshold', () => {
    const result = vacancy({
      title: 'Senior Frontend Developer, React',
      text: 'React, TypeScript, Next.js, Stripe, 3+ years',
      location: 'Remote, Europe',
      remote: true,
      llmRelevance: 80,
    });
    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.rejectedBy).toBeNull();
  });

  it('the same vacancy with an office in New York does not', () => {
    const result = vacancy({
      title: 'Senior Frontend Developer, React',
      text: 'React, TypeScript, Next.js, Stripe, 3+ years',
      location: 'New York, hybrid',
      remote: true,
      llmRelevance: 80,
    });
    expect(result.score).toBeLessThan(6);
  });

  it('a blacklisted company is excluded entirely', () => {
    const result = vacancy({ blacklisted: true });
    expect(result.excluded).toBe(true);
    expect(result.score).toBe(-100);
  });
});

describe('role stop words look at the title only', () => {
  it('a colleague in the description does not reject a frontend role', () => {
    expect(findStopWords('Frontend Engineer\nYou will pair with our ML engineers and a Java developer.', 'Frontend Engineer')).toEqual([]);
  });

  it('the role in the title still rejects', () => {
    expect(findStopWords('ML Engineer\nPyTorch', 'ML Engineer')).toEqual(['ml engineer']);
  });

  it('technologies still count anywhere in the text', () => {
    expect(findStopWords('Frontend Engineer\nOur stack is Angular.', 'Frontend Engineer')).toEqual(['angular']);
  });
});
