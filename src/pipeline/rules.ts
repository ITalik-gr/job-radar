import { z } from 'zod';
import { log } from '../lib/log.js';
import defaultRules from '../../config/scoring.json' with { type: 'json' };

/**
 * Правила відбору живуть у config/scoring.json, а не в коді. Причина проста:
 * ці списки доводиться правити щотижня, і кожна правка не має бути релізом.
 */

const numberMap = z.record(z.string(), z.number());

export const rulesSchema = z.object({
  threshold: z.number(),
  roleGate: z.object({
    enabled: z.boolean(),
    mustMatch: z.array(z.string()),
    neverMatch: z.array(z.string()),
  }),
  geo: z.object({
    enabled: z.boolean(),
    homeCity: z.array(z.string()),
    allowedRegions: z.array(z.string()),
    blockedRegions: z.array(z.string()),
    restrictionPhrases: z.array(z.string()),
    remoteMarkers: z.array(z.string()),
    penaltyBlockedRegion: z.number(),
    penaltyHybridElsewhere: z.number(),
    penaltyOnSitePlace: z.number(),
    bonusUkraineFriendly: z.number(),
  }),
  experience: z.object({
    years5: z.number(),
    years7: z.number(),
    leadTitle: z.number(),
    juniorBonus: z.number(),
  }),
  stopWords: z.array(z.string()),
  weights: z.object({
    titleMultiplier: z.number(),
    bodyCap: z.number(),
    terms: numberMap,
  }),
  context: z.object({
    equityOnly: z.number(),
    englishC1WithVideo: z.number(),
    noSalaryCompetitive: z.number(),
    ukrainianVacancy: z.number(),
  }),
  companySize: z.object({
    bigPenalty: z.number(),
    bigFrom: z.number(),
    midPenalty: z.number(),
    midFrom: z.number(),
    smallBonus: z.number(),
    smallUpTo: z.number(),
    knownBig: z.array(z.string()),
  }),
  companies: z.object({
    threshold: z.number(),
    sizeWeights: numberMap,
    tagWeights: numberMap,
    techWeights: numberMap,
    countryWeights: numberMap,
    hasCareersPage: z.number(),
    hasOpenVacancies: z.number(),
    hourlyRateBonus: numberMap,
  }),
});

export type Rules = z.infer<typeof rulesSchema>;

const CONFIG_PATH = process.env.SCORING_CONFIG ?? 'config/scoring.json';

/** Ключі, що починаються з підкреслення, це коментарі для людини. */
function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripComments) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '_') continue;
      result[key] = stripComments(item);
    }
    return result as T;
  }
  return value;
}

let cached: { rules: Rules; loadedAt: number } | null = null;

/**
 * Конфіг вшитий у бандл статичним імпортом, щоб код працював і на Workers,
 * де файлової системи немає.
 */
export function loadRules(): Rules {
  return rulesSchema.parse(stripComments(defaultRules));
}

/**
 * У Node конфіг додатково перечитується з диска, тому правку видно без перезапуску.
 * На Workers ця функція просто повертає вшиту версію.
 */
export async function refreshRules(path = CONFIG_PATH): Promise<Rules> {
  if (typeof process === 'undefined' || !process.versions?.node) return rules();

  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    cached = { rules: rulesSchema.parse(stripComments(raw)), loadedAt: Date.now() };
  } catch (error) {
    log.warn({ err: String(error) }, 'конфіг скорингу з диска не прочитався, лишаю вшитий');
  }
  return rules();
}

/** Періодичне перечитування конфіга у Node. Таймер не тримає процес живим. */
export function watchRules(intervalMs = 5000): void {
  if (typeof process === 'undefined' || !process.versions?.node) return;
  void refreshRules();
  const timer = setInterval(() => void refreshRules(), intervalMs);
  timer.unref?.();
}

export function rules(): Rules {
  cached ??= { rules: loadRules(), loadedAt: Date.now() };
  return cached.rules;
}

export function resetRulesCache(): void {
  cached = null;
}
