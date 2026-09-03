import { rules } from './rules.js';

/**
 * Скоринг детермінований і живе в коді, а списки в config/scoring.json.
 * Порядок перевірок навмисний: спершу відсіювання (стоп-слова, роль, гео),
 * потім бали. Дешеве попереду дорогого.
 */

export const STOP_WORD_SCORE = -100;
export const EXCLUDED_SCORE = -100;

export interface ScoreSignals {
  text: string;
  /** Домен і розмір компанії: гіганти проходять тільки з дуже сильним збігом. */
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
  /** Чому запис узагалі не показується. null, якщо показується. */
  rejectedBy: string | null;
}

/** Межа слова, яка не ламається на крапках і решітках: `.net`, `c#`, `next.js`. */
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
 * Роль за назвою. Без цієї перевірки "Sr. Manager, Accounting" набирає балів
 * з тексту про компанію, де згадані React і Next.js, і лізе в чергу.
 */
export function roleFits(title: string | null | undefined): { ok: boolean; reason: string | null } {
  const gate = rules().roleGate;
  if (!gate.enabled) return { ok: true, reason: null };

  const value = (title ?? '').toLowerCase();
  if (!value) return { ok: false, reason: 'без назви' };

  const banned = matchesAny(value, gate.neverMatch);
  if (banned) return { ok: false, reason: `назва містить "${banned}"` };

  const wanted = matchesAny(value, gate.mustMatch);
  if (!wanted) return { ok: false, reason: 'назва не схожа на інженерну' };

  return { ok: true, reason: null };
}

export interface GeoVerdict {
  eligible: boolean;
  reason: string;
  weight: number;
}

/**
 * Гео. Головна діра старої версії: прапорець remote вважався достатнім.
 * Насправді "Remote (US)" і "San Francisco, hybrid" означають, що з Києва не підходить.
 */
/** Збіг регіону по межі слова: без цього "ny" ловиться всередині "many". */
function containsRegion(haystack: string, regions: string[]): string | null {
  for (const region of regions) {
    const escaped = region.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'iu').test(haystack)) return region;
  }
  return null;
}

export function geoFits(location: string | null | undefined, text = '', title = ''): GeoVerdict {
  const geo = rules().geo;
  if (!geo.enabled) return { eligible: true, reason: 'перевірка гео вимкнена', weight: 0 };

  // Дефіси і слеші в локаціях ("In-Office", "Remote/US") ламають пошук підрядка.
  const place = (location ?? '').toLowerCase().replace(/[-/|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const body = text.toLowerCase().slice(0, 6000);
  const haystack = `${place} ${body}`;

  if (geo.homeCity.some((city) => haystack.includes(city))) {
    return { eligible: true, reason: 'згадані Київ або Україна', weight: geo.bonusUkraineFriendly };
  }

  // Місто часто ховається в назві: "Senior Engineer, Majors - NYC" при локації "Distributed".
  const inTitle = containsRegion(title.toLowerCase(), geo.blockedRegions);
  if (inTitle) {
    return { eligible: false, reason: `місто в назві вакансії: ${inTitle}`, weight: geo.penaltyBlockedRegion };
  }

  const allowed = containsRegion(place, geo.allowedRegions);
  if (allowed) return { eligible: true, reason: `дозволений регіон: ${allowed}`, weight: 0 };

  const hybrid = /\bhybrid\b|\bon-?site\b|\bin office\b|\bв офісі\b/.test(place);
  const blocked = containsRegion(place, geo.blockedRegions);

  if (hybrid && blocked) {
    return { eligible: false, reason: `офіс або гібрид у ${blocked}`, weight: geo.penaltyHybridElsewhere };
  }
  if (hybrid) {
    return { eligible: false, reason: 'гібрид чи офіс поза Києвом', weight: geo.penaltyHybridElsewhere };
  }
  if (blocked) {
    return { eligible: false, reason: `прив'язка до регіону: ${blocked}`, weight: geo.penaltyBlockedRegion };
  }

  const restriction = geo.restrictionPhrases.find((phrase) => body.includes(phrase));
  if (restriction) {
    return { eligible: false, reason: `в тексті: "${restriction}"`, weight: geo.penaltyBlockedRegion };
  }

  // Названо місце, але жодної ознаки віддаленості. Тоді це офіс, хай там що
  // написано в прапорці remote: саме так у чергу лізли "Barcelona" і "In-Office".
  const remoteMarker = geo.remoteMarkers.some((marker) => place.includes(marker));
  if (place.length > 1 && !remoteMarker) {
    return { eligible: false, reason: `локація "${location}" без ознак віддаленості`, weight: geo.penaltyOnSitePlace };
  }

  return { eligible: true, reason: 'обмежень не знайдено', weight: 0 };
}

/** Скільки років досвіду вимагають. Беремо найбільше згадане число. */
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
    reasons.push({ reason: `вимагають ${years}+ років`, weight: experience.years7 });
  } else if (years !== null && years >= 5) {
    reasons.push({ reason: `вимагають ${years}+ років`, weight: experience.years5 });
  }

  const lead = /\b(tech lead|team lead|engineering manager|head of|director|principal|staff)\b/.test(title) ||
    (signals.seniority ?? '').toLowerCase() === 'lead';
  if (lead) reasons.push({ reason: 'лідська позиція', weight: experience.leadTitle });

  if (/\b(junior|middle|mid-level)\b/.test(title)) {
    reasons.push({ reason: 'грейд без завищених вимог', weight: experience.juniorBonus });
  }

  return reasons;
}

/** Верхня межа розміру компанії з рядка каталогу: "10 - 49", "понад 1500", "200...800". */
export function companyHeadcount(sizeHint: string | null | undefined): number | null {
  if (!sizeHint) return null;
  const numbers = [...sizeHint.matchAll(/\d[\d\s,]*/g)]
    .map((match) => Number(match[0].replace(/[\s,]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

/**
 * Поправка на розмір компанії. Причина проста: у велику відому контору подача майже
 * завжди марна, тому вона має пройти поріг лише з дійсно сильним збігом.
 */
export function companySizeReason(signals: ScoreSignals): ScoreReason | null {
  const config = rules().companySize;
  const domain = (signals.companyDomain ?? '').toLowerCase();

  if (domain && config.knownBig.includes(domain)) {
    return { reason: 'велика відома компанія', weight: config.bigPenalty };
  }

  const headcount = companyHeadcount(signals.companySizeHint);
  if (headcount === null) return null;
  if (headcount >= config.bigFrom) return { reason: `${headcount}+ людей у компанії`, weight: config.bigPenalty };
  if (headcount >= config.midFrom) return { reason: `${headcount} людей у компанії`, weight: config.midPenalty };
  if (headcount <= config.smallUpTo) return { reason: 'невелика компанія', weight: config.smallBonus };
  return null;
}

function contextReasons(signals: ScoreSignals, haystack: string): ScoreReason[] {
  const { context } = rules();
  const reasons: ScoreReason[] = [];

  if (/equity only|unpaid|no salary|without pay|за долю|без оплати/.test(haystack)) {
    reasons.push({ reason: 'equity only або без оплати', weight: context.equityOnly });
  }

  const c1 =
    (signals.englishLevelRequired ?? '').toUpperCase().startsWith('C1') ||
    /\bc1\b|native english|native speaker|fluent english/.test(haystack);
  const video = /video interview|video call|відеозустріч|відеоінтервʼю|screening call/.test(haystack);
  if (c1 && video) {
    reasons.push({ reason: 'C1 англійська плюс відеоспівбесіда', weight: context.englishC1WithVideo });
  }

  const noSalary = !signals.salaryMin && !signals.salaryMax;
  if (noSalary && /competitive|конкурентн/.test(haystack)) {
    reasons.push({ reason: 'вилки немає, зате "competitive"', weight: context.noSalaryCompetitive });
  }

  // Вакансія українською означає, що співбесіда теж буде українською.
  // Це прямий плюс: письмова англійська сильна, довгий технічний дзвінок англійською ні.
  if (/[іїєґ]/i.test(haystack) && /(вакансі|розробник|досвід|обов|команд)/i.test(haystack)) {
    reasons.push({ reason: 'вакансія українською', weight: context.ukrainianVacancy });
  }

  return reasons;
}

/**
 * Бали за технології. Назва важить утричі, бали з тексту обмежені стелею:
 * інакше довгий блок "про компанію" з переліком стеку витягує нагору будь-що.
 */
function keywordReasons(title: string, body: string, remote: boolean | null | undefined): ScoreReason[] {
  const { weights } = rules();
  const positives: ScoreReason[] = [];
  let bodyTotal = 0;

  for (const [term, weight] of Object.entries(weights.terms)) {
    if (occurs(title, term)) {
      positives.push({ reason: `${term} у назві`, weight: weight * weights.titleMultiplier });
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
    return { ...empty, excluded: true, rejectedBy: 'компанія в blacklist' };
  }

  const stopWords = findStopWords(haystack);
  if (stopWords.length > 0) {
    return { ...empty, stopWords, rejectedBy: `стоп-слово: ${stopWords.join(', ')}` };
  }

  const role = roleFits(signals.title);
  if (!role.ok) {
    return { ...empty, rejectedBy: `не та роль: ${role.reason}` };
  }

  const geo = geoFits(signals.location, body, title);
  const positives = keywordReasons(title, body, signals.remote);
  // Контекстні причини бувають і з плюсом (вакансія українською, невелика компанія),
  // тому розкладаємо їх за знаком, а не складаємо все в мінуси.
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
    rejectedBy: geo.eligible ? null : `гео: ${geo.reason}`,
  };
}

export function explain(breakdown: ScoreBreakdown): string {
  const lines: string[] = [`рахунок: ${breakdown.score}`];
  if (breakdown.rejectedBy) lines.push(`відсіяно: ${breakdown.rejectedBy}`);
  for (const item of breakdown.positives) lines.push(`  +${item.weight}  ${item.reason}`);
  for (const item of breakdown.negatives) lines.push(`  ${item.weight}  ${item.reason}`);
  return lines.join('\n');
}
