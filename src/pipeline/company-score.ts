import type { Company } from '../db/schema.js';
import { rules } from './rules.js';
import type { ScoreReason } from './score.js';

/**
 * Скоринг компаній, яким варто написати. Це окрема від вакансій задача:
 * невеликій веб-студії вакансія не потрібна, потрібен виконавець на проєкт.
 * Тому тут важать розмір, профіль послуг, живий фронтендовий стек і країна,
 * а не наявність відкритої позиції.
 */

export interface CompanyScoreInput {
  company: Company;
  openVacancies?: number;
  status?: string | null;
}

export interface CompanyBreakdown {
  score: number;
  positives: ScoreReason[];
  negatives: ScoreReason[];
  rejectedBy: string | null;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

/** Розмір з каталогів приходить рядком: "10 - 49", "200...800 спеціалістів", "51-200". */
export function sizeBucket(sizeHint: string | null): string | null {
  if (!sizeHint) return null;
  const direct = Object.keys(rules().companies.sizeWeights).find(
    (key) => normalize(key) === normalize(sizeHint),
  );
  if (direct) return direct;

  const numbers = [...sizeHint.matchAll(/\d[\d\s,]*/g)]
    .map((match) => Number(match[0].replace(/[\s,]/g, '')))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;

  const upper = Math.max(...numbers);
  if (upper <= 9) return '1 - 9';
  if (upper <= 49) return '10 - 49';
  if (upper <= 249) return '50 - 249';
  if (upper <= 999) return '250 - 999';
  if (upper <= 9999) return '1,000 - 9,999';
  return '10,000+';
}

export function scoreCompany(input: CompanyScoreInput): CompanyBreakdown {
  const { companies: config } = rules();
  const { company } = input;
  const positives: ScoreReason[] = [];
  const negatives: ScoreReason[] = [];

  const push = (reason: string, weight: number) => {
    if (weight > 0) positives.push({ reason, weight });
    else if (weight < 0) negatives.push({ reason, weight });
  };

  if (input.status === 'blacklist') {
    return { score: -100, positives, negatives, rejectedBy: 'компанія в blacklist' };
  }

  const bucket = sizeBucket(company.sizeHint);
  if (bucket) push(`розмір ${bucket}`, config.sizeWeights[bucket] ?? 0);

  const tags = company.tags.map(normalize);
  for (const [tag, weight] of Object.entries(config.tagWeights)) {
    if (tags.some((value) => value.includes(normalize(tag)))) push(tag, weight);
  }

  for (const [tag, weight] of Object.entries(config.hourlyRateBonus)) {
    if (tags.some((value) => normalize(value) === normalize(tag))) push(`ставка ${tag}`, weight);
  }

  const tech = company.techHints.map(normalize);
  for (const [name, weight] of Object.entries(config.techWeights)) {
    if (tech.includes(normalize(name))) push(`стек: ${name}`, weight);
  }

  if (company.country) {
    const weight = config.countryWeights[company.country];
    if (weight) push(`країна ${company.country}`, weight);
  }

  if (company.careersUrl) push('є сторінка вакансій', config.hasCareersPage);
  if ((input.openVacancies ?? 0) > 0) push('є відкриті вакансії', config.hasOpenVacancies);

  const sum =
    positives.reduce((acc, item) => acc + item.weight, 0) +
    negatives.reduce((acc, item) => acc + item.weight, 0);

  return {
    score: Math.round(sum * 100) / 100,
    positives,
    negatives,
    rejectedBy: null,
  };
}
