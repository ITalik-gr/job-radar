import { eq } from 'drizzle-orm';
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

/**
 * Три джерела правил, у порядку старшинства:
 *
 *   база  →  файл на диску  →  вшита в бандл версія
 *
 * База найстарша, бо це те, що власник змінив з інтерфейсу, і на Workers це єдиний
 * спосіб щось змінити взагалі: файлової системи там немає. Файл лишається для
 * локальної роботи, коли зручніше правити конфіг у редакторі. Вшита версія це
 * значення за замовчуванням, з якого починається чистий запуск.
 *
 * Кеші тримаються окремо саме через це старшинство. Раніше був один кеш, і
 * періодичне перечитування файла затирало б правку з інтерфейсу через 5 секунд.
 */
let fromDb: Rules | null = null;
let fromFile: Rules | null = null;
let bundled: Rules | null = null;

/** Ключ у таблиці settings, під яким лежить весь обʼєкт правил. */
export const RULES_KEY = 'scoring';

/**
 * Конфіг вшитий у бандл статичним імпортом, щоб код працював і на Workers,
 * де файлової системи немає.
 */
export function loadRules(): Rules {
  return rulesSchema.parse(stripComments(defaultRules));
}

export function rules(): Rules {
  bundled ??= loadRules();
  return fromDb ?? fromFile ?? bundled;
}

/** Звідки взялись поточні правила. Потрібно інтерфейсу, щоб не брехати про джерело. */
export function rulesSource(): 'db' | 'file' | 'bundled' {
  if (fromDb) return 'db';
  if (fromFile) return 'file';
  return 'bundled';
}

/**
 * У Node конфіг додатково перечитується з диска, тому правку у файлі видно без
 * перезапуску. На Workers ця функція нічого не робить.
 */
export async function refreshRules(path = CONFIG_PATH): Promise<Rules> {
  if (typeof process === 'undefined' || !process.versions?.node) return rules();

  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    fromFile = rulesSchema.parse(stripComments(raw));
  } catch (error) {
    log.warn({ err: String(error) }, 'конфіг скорингу з диска не прочитався, лишаю вшитий');
  }
  return rules();
}

/** Перечитати правила з бази. Викликається на старті і після кожного збереження. */
export async function refreshRulesFromDb(): Promise<Rules> {
  try {
    const [{ getDb }, { settings }] = await Promise.all([
      import('../db/client.js'),
      import('../db/schema.js'),
    ]);
    const [row] = await getDb().select().from(settings).where(eq(settings.key, RULES_KEY));
    fromDb = row ? rulesSchema.parse(stripComments(row.value)) : null;
  } catch (error) {
    log.warn({ err: String(error) }, 'правила з бази не прочитались, лишаю файл або вшиті');
  }
  return rules();
}

/**
 * Зберегти правила з інтерфейсу. Приймається тільки повний обʼєкт: часткові патчі
 * вимагали б домовленості про злиття, і будь-яка помилка в ній тихо ламала б скоринг.
 * Zod тут не для форми, а для того, щоб у базу не потрапив конфіг, на якому впаде діф.
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
  log.info({ threshold: parsed.threshold }, 'правила збережено з інтерфейсу');
  return parsed;
}

/** Скинути правку з інтерфейсу і вернутись до файла або вшитої версії. */
export async function resetRules(): Promise<Rules> {
  const [{ getDb }, { settings }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
  ]);
  await getDb().delete(settings).where(eq(settings.key, RULES_KEY));
  fromDb = null;
  log.info('правила скинуто до значень за замовчуванням');
  return rules();
}

/** Періодичне перечитування конфіга у Node. Таймер не тримає процес живим. */
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
