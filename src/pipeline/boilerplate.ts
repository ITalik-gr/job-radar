import { eq, isNotNull, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { vacancies } from '../db/schema.js';

/**
 * Вирізання блока "про компанію" перед відправкою в модель.
 *
 * У всіх вакансій однієї компанії однаковий вступ і однаковий хвіст про пільги
 * і рівні можливості. На живих даних це 57 відсотків тексту у Cloudflare і 49
 * у Anthropic. Кожен такий блок оплачувався стільки разів, скільки в компанії
 * вакансій: опис Cloudflare 313 разів.
 *
 * Це пункт 1 зі списку "що ще можна зробити" в COSTS.md, найбільший з тих, що лишились.
 */

/** Менше цього спільна частина не варта вирізання: різниця в межах похибки. */
const MIN_AFFIX = 200;

/** Скільки тексту мусить лишитись. Захист від компаній з двома схожими вакансіями. */
const MIN_KEPT = 600;

/** Менше цієї кількості вакансій спільний префікс нічого не означає. */
const MIN_SAMPLES = 3;

export interface Affixes {
  prefix: number;
  suffix: number;
}

export const NO_AFFIXES: Affixes = { prefix: 0, suffix: 0 };

/**
 * Найдовший спільний префікс і суфікс набору текстів. Рахується символ у символ:
 * тексти вакансій однієї компанії збігаються буквально, а не приблизно.
 */
export function commonAffixes(texts: string[]): Affixes {
  const usable = texts.filter((text) => text.length > 0);
  if (usable.length < MIN_SAMPLES) return NO_AFFIXES;

  const shortest = usable.reduce((min, text) => Math.min(min, text.length), Infinity);
  const first = usable[0]!;

  let prefix = 0;
  while (prefix < shortest && usable.every((text) => text[prefix] === first[prefix])) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    usable.every((text) => text[text.length - 1 - suffix] === first[first.length - 1 - suffix])
  ) {
    suffix += 1;
  }

  return {
    prefix: prefix >= MIN_AFFIX ? prefix : 0,
    suffix: suffix >= MIN_AFFIX ? suffix : 0,
  };
}

/**
 * Обрізати спільні частини. Якщо після обрізання лишається надто мало, текст
 * повертається цілим: краще заплатити за зайві токени, ніж відправити в модель
 * недогризок і отримати вигадану вилку.
 */
export function stripBoilerplate(text: string, affixes: Affixes): string {
  if (!affixes.prefix && !affixes.suffix) return text;

  const kept = text.length - affixes.prefix - affixes.suffix;
  if (kept < MIN_KEPT) return text;

  return text.slice(affixes.prefix, text.length - affixes.suffix).trim();
}

/**
 * Спільні частини для компанії, порахувані по вже збережених вакансіях.
 * Кеш у межах процесу: під час одного прогону компанія трапляється десятки разів.
 */
const cache = new Map<number, Affixes>();

export async function affixesForCompany(companyId: number): Promise<Affixes> {
  const cached = cache.get(companyId);
  if (cached) return cached;

  const db = getDb();
  const rows = await db
    .select({ rawText: vacancies.rawText })
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNotNull(vacancies.rawText)))
    .limit(20);

  const affixes = commonAffixes(rows.map((row) => row.rawText ?? ''));
  cache.set(companyId, affixes);
  return affixes;
}

export function resetAffixCache(): void {
  cache.clear();
}
