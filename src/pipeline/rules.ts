import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { log } from '../lib/log.js';
import defaultRules from '../../config/scoring.json' with { type: 'json' };

/**
 * Selection rules live in config/scoring.json, not in code. The reason is simple: these lists get
 * edited every week, and an edit should not be a release.
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
    /*
     * Weight by company kind. An optional field with a default on purpose: without it a config saved
     * from the interface before the field existed would stop passing Zod, and scoring would silently
     * fall back to the bundled one.
     */
    kindWeights: numberMap.default({}),
    /*
     * Dead site penalty. Optional with a default, like kindWeights: a config saved from the interface
     * before the field existed must stay valid.
     */
    stale: z
      .object({
        /** How many years the copyright must lag behind the current one to count. */
        copyrightYearsBehind: z.number().default(2),
        copyrightPenalty: z.number().default(-4),
        /** How many days without a new post mean a dead blog. */
        blogSilentDays: z.number().default(540),
        blogPenalty: z.number().default(-2),
      })
      .default({}),
    hourlyRateBonus: numberMap,
    /*
     * Catalog reputation. Optional with defaults, like kindWeights and stale: a config saved from the
     * interface before the field existed must stay valid.
     */
    reputation: z
      .object({
        goodRating: z.number().default(4.5),
        goodRatingBonus: z.number().default(2),
        weakRating: z.number().default(4),
        weakRatingPenalty: z.number().default(-1),
        reviewsFrom: z.number().default(5),
        reviewsBonus: z.number().default(1),
        noReviewsPenalty: z.number().default(-1),
      })
      .default({}),
  }),
});

export type Rules = z.infer<typeof rulesSchema>;

const CONFIG_PATH = process.env.SCORING_CONFIG ?? 'config/scoring.json';

/** Keys starting with an underscore are comments for humans. */
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

/**
 * Three sources of rules, in order of precedence:
 *
 *   database  ->  file on disk  ->  version bundled into the build
 *
 * The database comes first, because that is what the owner changed from the interface, and on
 * Workers it is the only way to change anything at all: there is no filesystem. The file stays for
 * local work, when editing the config in an editor is handier. The bundled version is the default
 * a clean start begins with.
 *
 * The caches are kept apart precisely because of this precedence. There used to be one cache, and
 * periodically re-reading the file would have wiped an interface edit after 5 seconds.
 */
let fromDb: Rules | null = null;
let fromFile: Rules | null = null;
let bundled: Rules | null = null;

/** The key in the settings table that holds the whole rules object. */
export const RULES_KEY = 'scoring';

/**
 * The config is bundled with a static import, so the code works on Workers too, where there is no
 * filesystem.
 */
export function loadRules(): Rules {
  return rulesSchema.parse(stripComments(defaultRules));
}

export function rules(): Rules {
  bundled ??= loadRules();
  return fromDb ?? fromFile ?? bundled;
}

/** Where the current rules came from. The interface needs it so it does not lie about the source. */
export function rulesSource(): 'db' | 'file' | 'bundled' {
  if (fromDb) return 'db';
  if (fromFile) return 'file';
  return 'bundled';
}

/**
 * In Node the config is additionally re-read from disk, so an edit in the file is visible without a
 * restart. On Workers this function does nothing.
 */
export async function refreshRules(path = CONFIG_PATH): Promise<Rules> {
  if (typeof process === 'undefined' || !process.versions?.node) return rules();

  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    fromFile = rulesSchema.parse(stripComments(raw));
  } catch (error) {
    log.warn({ err: String(error) }, 'scoring config could not be read from disk, keeping the bundled one');
  }
  return rules();
}

/** Re-read the rules from the database. Called at startup and after every save. */
export async function refreshRulesFromDb(): Promise<Rules> {
  try {
    const [{ getDb }, { settings }] = await Promise.all([
      import('../db/client.js'),
      import('../db/schema.js'),
    ]);
    const [row] = await getDb().select().from(settings).where(eq(settings.key, RULES_KEY));
    fromDb = row ? rulesSchema.parse(stripComments(row.value)) : null;
  } catch (error) {
    log.warn({ err: String(error) }, 'rules could not be read from the database, keeping the file or the bundled ones');
  }
  return rules();
}

/**
 * Save rules from the interface. Only a full object is accepted: partial patches would need a merge
 * convention, and any mistake in it would silently break scoring. Zod here is not for the form but
 * to keep out of the database a config the diff would crash on.
 */
export async function saveRules(next: unknown): Promise<Rules> {
  const parsed = rulesSchema.parse(stripComments(next));
  const [{ getDb }, { settings }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
  ]);

  await getDb()
    .insert(settings)
    .values({ key: RULES_KEY, value: parsed, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: parsed, updatedAt: Date.now() },
    });

  fromDb = parsed;
  log.info({ threshold: parsed.threshold }, 'rules saved from the interface');
  return parsed;
}

/** Drop the interface edit and go back to the file or the bundled version. */
export async function resetRules(): Promise<Rules> {
  const [{ getDb }, { settings }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
  ]);
  await getDb().delete(settings).where(eq(settings.key, RULES_KEY));
  fromDb = null;
  log.info('rules reset to defaults');
  return rules();
}

/** Periodic config re-read in Node. The timer does not keep the process alive. */
export function watchRules(intervalMs = 5000): void {
  if (typeof process === 'undefined' || !process.versions?.node) return;
  void refreshRules();
  const timer = setInterval(() => void refreshRules(), intervalMs);
  timer.unref?.();
}

export function resetRulesCache(): void {
  fromDb = null;
  fromFile = null;
  bundled = null;
}
