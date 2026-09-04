import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies } from '../db/schema.js';
import { log } from '../lib/log.js';

/**
 * Перенести ставку і мінімальний проєкт з тегів у власні колонки.
 *
 * До появи колонок каталоги клали "$50 - $99 / hr" і "$10,000+" просто в теги,
 * поруч з послугами. Це видно в фільтрі за тегами як сміття, а нові фільтри
 * і CSV читають колонки, тобто для вже зібраних компаній вони порожні.
 *
 * Перезбирати каталоги заради цього не треба: дані вже лежать у базі, їх
 * достатньо розкласти по місцях. Оцінку і кількість відгуків так відновити
 * не можна, їх у тегах ніколи не було, тому вони зʼявляться лише на новому зборі.
 */

/**
 * "$50 - $99 / hr", "$50-$99/hr", "< $25 / hr", "$300+ / hr". Тире буває звичайне,
 * довге і середнє, а межі діапазону каталоги пишуть і знаком менше, і плюсом.
 */
const RATE = /^[<>]?\s?\$\s?\d[\d,]*\s*(?:(?:[-–—]|to)\s*\$?\d[\d,]*)?\+?\s*\/?\s*hr\.?$/i;
/** "$10,000+", "$5,000+". Без "/hr", інакше це ставка. */
const MIN_PROJECT = /^\$\s?\d[\d,]*\+$/;
/** "Founded 2015", "Since 2009". */
const FOUNDED = /^(?:founded|established|since)\D{0,4}(19\d{2}|20\d{2})$/i;

/**
 * Сміття, яке каталоги віддають разом із послугами. Це не теги: це підписи діаграм
 * ("Allocation of expertise by %"), оцінки рейтингу ("9.5/10 Market Presence"),
 * кнопки ("Was this helpful?") і лічильники відгуків. У фільтрі за тегами вони
 * заважають, у скорингу не важать нічого, а в картці просто займають місце.
 */
const TAG_NOISE = [
  /^allocation of expertise/i,
  /^was this helpful/i,
  /^service focus\b/i,
  /^\d+(?:\.\d+)?\/\d+\b/,
  /reviews? mention/i,
  /^\d[\d,]*\s*reviews?$/i,
  /^(see|show|read|view)\b/i,
  // Після зняття частки спереду будь-який відсоток усередині означає підпис діаграми,
  // а не назву послуги: "Web Design 45% Other" це хвіст "Service focus 50% ...".
  /\d+%/,
  /^\+?\d+\s*services?$/i,
];

/** "25% Web Development" це та сама послуга, просто з часткою від діаграми попереду. */
function cleanTag(tag: string): string {
  return tag
    .trim()
    .replace(/^\d+(?:\.\d+)?%\s*/, '')
    .replace(/\s*\+\d+\s*services?$/i, '')
    .trim();
}

export interface BackfillStats {
  /** Скільки компаній переглянуто. */
  seen: number;
  rate: number;
  minProject: number;
  founded: number;
  /** Скільки тегів прибрано, бо вони переїхали в колонки або виявились сміттям. */
  tagsRemoved: number;
}

/** Почистити теги однієї компанії: зняти частки, прибрати сміття, звести дублі. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const tag = cleanTag(raw);
    if (!tag || tag.length < 2) continue;
    if (TAG_NOISE.some((pattern) => pattern.test(tag))) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  return result;
}

export async function backfillCatalogFields(): Promise<BackfillStats> {
  const db = getDb();
  const rows = await db.select().from(companies);
  const stats: BackfillStats = { seen: rows.length, rate: 0, minProject: 0, founded: 0, tagsRemoved: 0 };

  for (const row of rows) {
    const rate = row.tags.find((tag) => RATE.test(tag.trim()));
    const minProject = row.tags.find((tag) => MIN_PROJECT.test(tag.trim()));
    const founded = row.tags.map((tag) => FOUNDED.exec(tag.trim())).find(Boolean);

    // Уже заповнене не чіпаємо: свіжий збір точніший за тег, який лежить роками.
    const nextRate = row.hourlyRate ?? rate ?? null;
    const nextMinProject = row.minProject ?? minProject ?? null;
    const nextFounded = row.foundedYear ?? (founded ? Number(founded[1]) : null);

    const tags = cleanTags(
      row.tags.filter((tag) => tag !== rate && tag !== minProject && tag !== founded?.[0]),
    );
    const removed = row.tags.length - tags.length;

    if (
      nextRate === row.hourlyRate &&
      nextMinProject === row.minProject &&
      nextFounded === row.foundedYear &&
      removed === 0 &&
      tags.join('|') === row.tags.join('|')
    ) {
      continue;
    }

    if (!row.hourlyRate && rate) stats.rate += 1;
    if (!row.minProject && minProject) stats.minProject += 1;
    if (!row.foundedYear && founded) stats.founded += 1;
    stats.tagsRemoved += removed;

    await db
      .update(companies)
      .set({ hourlyRate: nextRate, minProject: nextMinProject, foundedYear: nextFounded, tags })
      .where(eq(companies.id, row.id));
  }

  log.info(stats, 'поля каталогу розкладені по колонках');
  return stats;
}
