import { rules } from './rules.js';

/**
 * Scoring is deterministic and lives in code, while the lists live in config/scoring.json.
 * The order of checks is deliberate: filtering first (stop words, role, geo), then points.
 * Cheap before expensive.
 */

export const STOP_WORD_SCORE = -100;
export const EXCLUDED_SCORE = -100;

export interface ScoreSignals {
  text: string;
  /** Company domain and size: giants pass only with a very strong match. */
  companyDomain?: string | null;
  companySizeHint?: string | null;
  title?: string | null;
  location?: string | null;
  remote?: boolean | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  seniority?: string | null;
  englishLevelRequired?: string | null;
  llmRelevance?: number | null;
  blacklisted?: boolean;
}

export interface ScoreReason {
  reason: string;
  weight: number;
}

export interface ScoreBreakdown {
  score: number;
  stopWords: string[];
  positives: ScoreReason[];
  negatives: ScoreReason[];
  excluded: boolean;
  /** Why the record is not shown at all. null if it is shown. */
  rejectedBy: string | null;
}

/** A word boundary that does not break on dots and hashes: `.net`, `c#`, `next.js`. */
function occurs(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^[a-z0-9]/.test(needle) ? '(?<![a-z0-9])' : '(?<![a-z0-9.])';
  const after = /[a-z0-9]$/.test(needle) ? '(?![a-z0-9])' : '';
  return new RegExp(`${before}${escaped}${after}`, 'iu').test(haystack);
}

function matchesAny(haystack: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'iu').test(haystack)) return pattern;
  }
  return null;
}

export function findStopWords(text: string): string[] {
  const haystack = text.toLowerCase();
  return rules().stopWords.filter((word) => occurs(haystack, word));
}

export function hasStopWord(text: string): boolean {
  return findStopWords(text).length > 0;
}

/**
 * Role by title. Without this check "Sr. Manager, Accounting" scores points from company text
 * that mentions React and Next.js, and gets into the queue.
 */
export function roleFits(title: string | null | undefined): { ok: boolean; reason: string | null } {
  const gate = rules().roleGate;
  if (!gate.enabled) return { ok: true, reason: null };

  const value = (title ?? '').toLowerCase();
  if (!value) return { ok: false, reason: 'no title' };

  const banned = matchesAny(value, gate.neverMatch);
  if (banned) return { ok: false, reason: `title contains "${banned}"` };

  const wanted = matchesAny(value, gate.mustMatch);
  if (!wanted) return { ok: false, reason: 'the title does not look like an engineering role' };

  return { ok: true, reason: null };
}

export interface GeoVerdict {
  eligible: boolean;
  reason: string;
  weight: number;
}

/**
 * Geo. The main hole in the old version: the remote flag was considered enough. In fact
 * "Remote (US)" and "San Francisco, hybrid" mean it does not work from the home city.
 */
/** Region match on word boundaries: without it "ny" matches inside "many". */
function containsRegion(haystack: string, regions: string[]): string | null {
  for (const region of regions) {
    const escaped = region.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'iu').test(haystack)) return region;
  }
  return null;
}

export function geoFits(location: string | null | undefined, text = '', title = ''): GeoVerdict {
  const geo = rules().geo;
  if (!geo.enabled) return { eligible: true, reason: 'geo check disabled', weight: 0 };

  // Hyphens and slashes in locations ("In-Office", "Remote/US") break substring search.
  const place = (location ?? '').toLowerCase().replace(/[-/|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const body = text.toLowerCase().slice(0, 6000);
  const haystack = `${place} ${body}`;

  if (geo.homeCity.some((city) => haystack.includes(city))) {
    return { eligible: true, reason: 'home city or country mentioned', weight: geo.bonusUkraineFriendly };
  }

  // A city often hides in the title: "Senior Engineer, Majors - NYC" with location "Distributed".
  const inTitle = containsRegion(title.toLowerCase(), geo.blockedRegions);
  if (inTitle) {
    return { eligible: false, reason: `city in the vacancy title: ${inTitle}`, weight: geo.penaltyBlockedRegion };
  }

  const allowed = containsRegion(place, geo.allowedRegions);
  if (allowed) return { eligible: true, reason: `allowed region: ${allowed}`, weight: 0 };

  const hybrid = /\bhybrid\b|\bon-?site\b|\bin office\b|\bв офісі\b/.test(place);
  const blocked = containsRegion(place, geo.blockedRegions);

  if (hybrid && blocked) {
    return { eligible: false, reason: `office or hybrid in ${blocked}`, weight: geo.penaltyHybridElsewhere };
  }
  if (hybrid) {
    return { eligible: false, reason: 'hybrid or office outside the home city', weight: geo.penaltyHybridElsewhere };
  }
  if (blocked) {
    return { eligible: false, reason: `tied to a region: ${blocked}`, weight: geo.penaltyBlockedRegion };
  }

  const restriction = geo.restrictionPhrases.find((phrase) => body.includes(phrase));
  if (restriction) {
    return { eligible: false, reason: `in the text: "${restriction}"`, weight: geo.penaltyBlockedRegion };
  }

  // A place is named, but there is no sign of remote work. Then it is an office, whatever the
  // remote flag says: that is exactly how "Barcelona" and "In-Office" got into the queue.
  const remoteMarker = geo.remoteMarkers.some((marker) => place.includes(marker));
  if (place.length > 1 && !remoteMarker) {
    return { eligible: false, reason: `location "${location}" with no sign of remote work`, weight: geo.penaltyOnSitePlace };
  }

  return { eligible: true, reason: 'no restrictions found', weight: 0 };
}

/** How many years of experience are required. The largest number mentioned wins. Ukrainian forms are matched too. */
export function requiredYears(text: string): number | null {
  const matches = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*\d{0,2}\s*(?:years|yrs|роки|років|рок)/giu)];
  const years = matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 20);
  return years.length > 0 ? Math.max(...years) : null;
}

function experienceReasons(signals: ScoreSignals, haystack: string, title: string): ScoreReason[] {
  const { experience } = rules();
  const reasons: ScoreReason[] = [];

  const years = requiredYears(haystack);
  if (years !== null && years >= 7) {
    reasons.push({ reason: `requires ${years}+ years`, weight: experience.years7 });
  } else if (years !== null && years >= 5) {
    reasons.push({ reason: `requires ${years}+ years`, weight: experience.years5 });
  }

  const lead = /\b(tech lead|team lead|engineering manager|head of|director|principal|staff)\b/.test(title) ||
    (signals.seniority ?? '').toLowerCase() === 'lead';
  if (lead) reasons.push({ reason: 'lead position', weight: experience.leadTitle });

  if (/\b(junior|middle|mid-level)\b/.test(title)) {
    reasons.push({ reason: 'seniority without inflated requirements', weight: experience.juniorBonus });
  }

  return reasons;
}

/** Upper bound of company size from a catalog string: "10 - 49", "понад 1500" (DOU), "200...800". */
export function companyHeadcount(sizeHint: string | null | undefined): number | null {
  if (!sizeHint) return null;
  const numbers = [...sizeHint.matchAll(/\d[\d\s,]*/g)]
    .map((match) => Number(match[0].replace(/[\s,]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

/**
 * Company size adjustment. The reason is simple: applying to a large famous company is almost
 * always futile, so it should clear the threshold only with a really strong match.
 */
export function companySizeReason(signals: ScoreSignals): ScoreReason | null {
  const config = rules().companySize;
  const domain = (signals.companyDomain ?? '').toLowerCase();

  if (domain && config.knownBig.includes(domain)) {
    return { reason: 'large well-known company', weight: config.bigPenalty };
  }

  const headcount = companyHeadcount(signals.companySizeHint);
  if (headcount === null) return null;
  if (headcount >= config.bigFrom) return { reason: `${headcount}+ people in the company`, weight: config.bigPenalty };
  if (headcount >= config.midFrom) return { reason: `${headcount} people in the company`, weight: config.midPenalty };
  if (headcount <= config.smallUpTo) return { reason: 'small company', weight: config.smallBonus };
  return null;
}

function contextReasons(signals: ScoreSignals, haystack: string): ScoreReason[] {
  const { context } = rules();
  const reasons: ScoreReason[] = [];

  if (/equity only|unpaid|no salary|without pay|за долю|без оплати/.test(haystack)) {
    reasons.push({ reason: 'equity only or unpaid', weight: context.equityOnly });
  }

  const c1 =
    (signals.englishLevelRequired ?? '').toUpperCase().startsWith('C1') ||
    /\bc1\b|native english|native speaker|fluent english/.test(haystack);
  const video = /video interview|video call|відеозустріч|відеоінтервʼю|screening call/.test(haystack);
  if (c1 && video) {
    reasons.push({ reason: 'C1 English plus a video interview', weight: context.englishC1WithVideo });
  }

  const noSalary = !signals.salaryMin && !signals.salaryMax;
  if (noSalary && /competitive|конкурентн/.test(haystack)) {
    reasons.push({ reason: 'no salary range, but "competitive"', weight: context.noSalaryCompetitive });
  }

  // A vacancy written in Ukrainian means the interview will be in Ukrainian too. The regexes
  // below match Ukrainian letters and words on purpose. It is a plus for an owner whose written
  // English is strong and whose long technical calls in English are not.
  if (/[іїєґ]/i.test(haystack) && /(вакансі|розробник|досвід|обов|команд)/i.test(haystack)) {
    reasons.push({ reason: 'vacancy in Ukrainian', weight: context.ukrainianVacancy });
  }

  return reasons;
}

/**
 * Points for technologies. The title weighs three times as much, text points are capped:
 * otherwise a long "about the company" block listing the stack pulls anything to the top.
 */
function keywordReasons(title: string, body: string, remote: boolean | null | undefined): ScoreReason[] {
  const { weights } = rules();
  const positives: ScoreReason[] = [];
  let bodyTotal = 0;

  for (const [term, weight] of Object.entries(weights.terms)) {
    if (occurs(title, term)) {
      positives.push({ reason: `${term} in the title`, weight: weight * weights.titleMultiplier });
      continue;
    }
    if (occurs(body, term)) {
      if (bodyTotal + weight > weights.bodyCap) continue;
      bodyTotal += weight;
      positives.push({ reason: term, weight });
    }
  }

  if (remote === true && !positives.some((item) => item.reason.startsWith('remote'))) {
    const weight = weights.terms.remote ?? 0;
    if (weight) positives.push({ reason: 'remote', weight });
  }

  return positives;
}

export function scoreVacancy(signals: ScoreSignals): ScoreBreakdown {
  const title = (signals.title ?? '').toLowerCase();
  const body = signals.text.toLowerCase();
  const haystack = `${title}\n${body}`;

  const empty: ScoreBreakdown = {
    score: EXCLUDED_SCORE,
    stopWords: [],
    positives: [],
    negatives: [],
    excluded: false,
    rejectedBy: null,
  };

  if (signals.blacklisted) {
    return { ...empty, excluded: true, rejectedBy: 'company is blacklisted' };
  }

  const stopWords = findStopWords(haystack);
  if (stopWords.length > 0) {
    return { ...empty, stopWords, rejectedBy: `stop word: ${stopWords.join(', ')}` };
  }

  const role = roleFits(signals.title);
  if (!role.ok) {
    return { ...empty, rejectedBy: `wrong role: ${role.reason}` };
  }

  const geo = geoFits(signals.location, body, title);
  const positives = keywordReasons(title, body, signals.remote);
  // Context reasons can carry a plus too (vacancy in Ukrainian, small company), so they are
  // split by sign rather than all counted as minuses.
  const contextual = [...experienceReasons(signals, haystack, title), ...contextReasons(signals, haystack)];
  const size = companySizeReason(signals);
  if (size) contextual.push(size);

  const negatives: ScoreReason[] = [];
  for (const item of contextual) (item.weight > 0 ? positives : negatives).push(item);

  if (geo.weight > 0) positives.push({ reason: geo.reason, weight: geo.weight });
  if (geo.weight < 0) negatives.push({ reason: geo.reason, weight: geo.weight });

  const sum =
    positives.reduce((acc, item) => acc + item.weight, 0) +
    negatives.reduce((acc, item) => acc + item.weight, 0) +
    (signals.llmRelevance ?? 0) / 20;

  return {
    score: Math.round(sum * 100) / 100,
    stopWords,
    positives,
    negatives,
    excluded: false,
    rejectedBy: geo.eligible ? null : `geo: ${geo.reason}`,
  };
}

export function explain(breakdown: ScoreBreakdown): string {
  const lines: string[] = [`score: ${breakdown.score}`];
  if (breakdown.rejectedBy) lines.push(`rejected: ${breakdown.rejectedBy}`);
  for (const item of breakdown.positives) lines.push(`  +${item.weight}  ${item.reason}`);
  for (const item of breakdown.negatives) lines.push(`  ${item.weight}  ${item.reason}`);
  return lines.join('\n');
}
