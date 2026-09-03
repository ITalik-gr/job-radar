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

describe('конфіг', () => {
  it('гемблінг, адулт і форекс більше не відсіюються', () => {
    const rules = loadRules();
    for (const word of ['gambling', 'betting', 'casino', 'adult', 'forex']) {
      expect(rules.stopWords).not.toContain(word);
    }
  });

  it('config/scoring.json валідний і містить усі розділи', () => {
    const rules = loadRules();
    expect(rules.stopWords).toContain('angular');
    expect(rules.geo.blockedRegions).toContain('san francisco');
    expect(rules.weights.terms['react']).toBe(3);
    expect(rules.companies.sizeWeights['10 - 49']).toBe(5);
  });
});

describe('стоп-слова', () => {
  it('ловлять чужі технології, не чіпаючи схожі слова', () => {
    expect(findStopWords('Senior Angular Developer')).toEqual(['angular']);
    expect(hasStopWord('We need a .NET and C# engineer')).toBe(true);
    expect(findStopWords('React developer with Node')).toEqual([]);
    expect(findStopWords('we use nextjs and dotnetify-like tools')).toEqual([]);
  });
});

describe('роль за назвою', () => {
  it('пропускає інженерні назви', () => {
    expect(roleFits('Senior Frontend Developer').ok).toBe(true);
    expect(roleFits('Full-Stack Engineer, AI').ok).toBe(true);
    expect(roleFits('Розробник React').ok).toBe(true);
  });

  it('відсікає нетехнічні ролі, навіть коли в описі повно стеку', () => {
    expect(roleFits('Sr. Manager, Accounting (India)').ok).toBe(false);
    expect(roleFits('Account Executive, Commercial').ok).toBe(false);
    expect(roleFits('Developer Relations Engineer').ok).toBe(false);
    expect(roleFits('Product Manager').ok).toBe(false);
  });

  it('бухгалтер з описом компанії про Next.js отримує -100, а не 7 балів', () => {
    const result = vacancy({
      title: 'Sr. Manager, Accounting (India)',
      text: 'About Vercel: the team behind Next.js, v0, and AI SDK. React, TypeScript everywhere.',
    });
    expect(result.score).toBe(-100);
    expect(result.rejectedBy).toContain('не та роль');
  });
});

describe('гео', () => {
  it('remote з прив\'язкою до США не підходить', () => {
    const verdict = geoFits('Remote, United States');
    expect(verdict.eligible).toBe(false);
    expect(verdict.weight).toBeLessThan(0);
  });

  it('гібрид у Сан-Франциско не підходить, навіть якщо стоїть прапорець remote', () => {
    const result = vacancy({ location: 'San Francisco, hybrid', remote: true });
    expect(result.rejectedBy).toContain('гео');
    expect(result.score).toBeLessThan(6);
  });

  it('Європа, worldwide і anywhere підходять', () => {
    expect(geoFits('Remote, Europe').eligible).toBe(true);
    expect(geoFits('Worldwide').eligible).toBe(true);
    expect(geoFits('Remote, Global').eligible).toBe(true);
  });

  it('Київ і Україна дають бонус', () => {
    const verdict = geoFits('Kyiv, hybrid');
    expect(verdict.eligible).toBe(true);
    expect(verdict.weight).toBeGreaterThan(0);
  });

  it('обмеження в тексті ловиться, коли локація виглядає нейтрально', () => {
    const verdict = geoFits('Remote', 'You must be located in the United States to apply.');
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain('must be located in');
  });

  it('вакансія без згадок про регіон не карається', () => {
    expect(geoFits('Remote').eligible).toBe(true);
    expect(geoFits(null).eligible).toBe(true);
  });
});

describe('досвід', () => {
  it('витягує найбільшу вимогу років з тексту', () => {
    expect(requiredYears('3+ years of experience')).toBe(3);
    expect(requiredYears('5+ years building web apps')).toBe(5);
    expect(requiredYears('at least 7 years, ideally 10 years')).toBe(10);
    expect(requiredYears('no numbers here')).toBeNull();
  });

  it('5+ років це помітний мінус, 7+ значно більший', () => {
    const five = vacancy({ text: 'react typescript, 5+ years of experience' });
    const seven = vacancy({ text: 'react typescript, 7+ years of experience' });
    expect(five.negatives.some((item) => item.weight === -3)).toBe(true);
    expect(seven.negatives.some((item) => item.weight === -8)).toBe(true);
    expect(seven.score).toBeLessThan(five.score);
  });

  it('лідська назва карається окремо від років', () => {
    const result = vacancy({ title: 'Staff Frontend Engineer' });
    expect(result.negatives.some((item) => item.reason === 'лідська позиція')).toBe(true);
  });
});

describe('бали за технології', () => {
  it('збіг у назві важить утричі', () => {
    const inTitle = vacancy({ title: 'React Developer', text: 'ми пишемо на чомусь' });
    expect(inTitle.positives.find((item) => item.reason.includes('react'))!.weight).toBe(9);
  });

  it('текст про компанію не може накрутити більше за стелю', () => {
    const result = vacancy({
      title: 'Web Developer',
      text: 'react typescript next.js nestjs cloudflare node stripe postgresql astro prisma tailwind llm claude openai anthropic',
    });
    const fromBody = result.positives
      .filter((item) => !item.reason.includes('у назві'))
      .reduce((sum, item) => sum + item.weight, 0);
    expect(fromBody).toBeLessThanOrEqual(8);
  });

  it('llm_relevance додає не більше пʼяти балів', () => {
    const base = vacancy();
    const withLlm = vacancy({ llmRelevance: 100 });
    expect(withLlm.score - base.score).toBe(5);
  });
});

describe('розмір компанії', () => {
  it('відома велика контора отримує помітний мінус', () => {
    const big = vacancy({ companyDomain: 'stripe.com', location: 'Remote, Europe' });
    const small = vacancy({ companyDomain: 'tiny-studio.com', location: 'Remote, Europe' });
    expect(big.negatives.some((item) => item.reason === 'велика відома компанія')).toBe(true);
    expect(big.score).toBeLessThan(small.score);
  });

  it('розмір з каталогу теж враховується', () => {
    const huge = vacancy({ companySizeHint: '1,000 - 9,999', location: 'Remote, Europe' });
    const tiny = vacancy({ companySizeHint: '10 - 49', location: 'Remote, Europe' });
    expect(huge.score).toBeLessThan(tiny.score);
    expect(tiny.positives.some((item) => item.reason === 'невелика компанія')).toBe(true);
  });

  it('гігант проходить поріг лише з дуже сильним збігом', () => {
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

describe('вакансія українською', () => {
  it('отримує бонус, бо співбесіда буде українською', () => {
    const ua = vacancy({
      title: 'Frontend розробник',
      text: 'Шукаємо розробника з досвідом React, обовʼязки: розробка інтерфейсів, команда 10 осіб',
    });
    expect(ua.positives.some((item) => item.reason === 'вакансія українською')).toBe(true);
  });
});

describe('підсумок', () => {
  it('релевантна європейська віддалена вакансія проходить поріг', () => {
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

  it('та сама вакансія з офісом у Нью-Йорку не проходить', () => {
    const result = vacancy({
      title: 'Senior Frontend Developer, React',
      text: 'React, TypeScript, Next.js, Stripe, 3+ years',
      location: 'New York, hybrid',
      remote: true,
      llmRelevance: 80,
    });
    expect(result.score).toBeLessThan(6);
  });

  it('компанія в blacklist виключається повністю', () => {
    const result = vacancy({ blacklisted: true });
    expect(result.excluded).toBe(true);
    expect(result.score).toBe(-100);
  });
});
