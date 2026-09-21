import type { Company } from '../db/schema.js';
import { rules } from './rules.js';
import type { ScoreReason } from './score.js';

/**
 * Scoring companies worth writing to. A separate task from vacancies: a small web studio needs no
 * vacancy, it needs a contractor for a project. So what matters here is size, service profile, a
 * living front end stack and country, not an open position.
 */

export interface CompanyScoreInput {
  company: Company;
  openVacancies?: number;
  status?: string | null;
  /** The current time. A separate field so the staleness penalty can be tested. */
  now?: number;
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

/** Size from catalogs arrives as a string: "10 - 49", "200...800 спеціалістів" (DOU), "51-200". */
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
    return { score: -100, positives, negatives, rejectedBy: 'company is blacklisted' };
  }

  const bucket = sizeBucket(company.sizeHint);
  if (bucket) push(`size ${bucket}`, config.sizeWeights[bucket] ?? 0);

  const tags = company.tags.map(normalize);
  for (const [tag, weight] of Object.entries(config.tagWeights)) {
    if (tags.some((value) => value.includes(normalize(tag)))) push(tag, weight);
  }

  /*
   * The hourly rate now has its own column, but in companies collected earlier it sits among the
   * tags. Both places are read, otherwise the backfill would cost re-collecting the catalogs.
   */
  const rateCandidates = [company.hourlyRate, ...tags].filter((value): value is string => Boolean(value));
  for (const [tag, weight] of Object.entries(config.hourlyRateBonus)) {
    if (rateCandidates.some((value) => normalize(value) === normalize(tag))) push(`rate ${tag}`, weight);
  }

  /*
   * Catalog reputation. A studio with dozens of reviews and a high rating really works with
   * clients, so there is someone to read the letter. A profile without a single review is often
   * just filled in and abandoned, hence a separate small penalty.
   */
  const reputation = config.reputation;
  if (reputation) {
    if (company.rating !== null && company.rating >= reputation.goodRating) {
      push(`rating ${company.rating}`, reputation.goodRatingBonus);
    }
    if (company.rating !== null && company.rating > 0 && company.rating < reputation.weakRating) {
      push(`low rating ${company.rating}`, reputation.weakRatingPenalty);
    }
    if ((company.reviewsCount ?? 0) >= reputation.reviewsFrom) {
      push(`${company.reviewsCount} reviews`, reputation.reviewsBonus);
    }
    if (company.reviewsCount === 0) push('no reviews', reputation.noReviewsPenalty);
  }

  const tech = company.techHints.map(normalize);
  for (const [name, weight] of Object.entries(config.techWeights)) {
    if (tech.includes(normalize(name))) push(`stack: ${name}`, weight);
  }

  if (company.country) {
    const weight = config.countryWeights[company.country];
    if (weight) push(`country ${company.country}`, weight);
  }

  const kindWeight = config.kindWeights?.[company.kind];
  if (kindWeight) push(`kind: ${company.kind}`, kindWeight);

  /*
   * A dead site. The idea from STATUS.md: an agency whose last post dates from 2019 neither hires
   * nor answers. Enrichment collects the signs, so the penalty appears only after a pass over the
   * site rather than being guessed out of thin air.
   */
  const stale = config.stale;
  if (stale) {
    const thisYear = new Date(input.now ?? Date.now()).getFullYear();
    if (company.copyrightYear && thisYear - company.copyrightYear >= stale.copyrightYearsBehind) {
      push(`copyright ${company.copyrightYear}`, stale.copyrightPenalty);
    }

    if (company.lastPostAt) {
      const silentDays = ((input.now ?? Date.now()) - company.lastPostAt) / 86_400_000;
      if (silentDays >= stale.blogSilentDays) {
        push(`no posts for ${Math.round(silentDays)} days`, stale.blogPenalty);
      }
    }
  }

  if (company.careersUrl) push('has a careers page', config.hasCareersPage);
  if ((input.openVacancies ?? 0) > 0) push('has open vacancies', config.hasOpenVacancies);

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
