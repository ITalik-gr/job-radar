import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { log } from './log.js';

/**
 * Простий JSON-сховок поверх таблиці `settings`.
 *
 * Таблиця вже існує для правил скорингу, і другий раз вигадувати місце під
 * дрібний довгоживучий стан не треба. Використовується там, де дані дорого
 * добувати заново, але вони майже не змінюються: наприклад відповідність
 * slug компанії на дошці вакансій до її справжнього домену.
 */
export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
    return row ? (row.value as T) : fallback;
  } catch (error) {
    // Відсутнє сховище не має валити прогін: працюємо без кешу.
    log.warn({ key, err: String(error) }, 'налаштування не прочитались');
    return fallback;
  }
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  try {
    await getDb()
      .insert(settings)
      .values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } });
  } catch (error) {
    log.warn({ key, err: String(error) }, 'налаштування не збереглись');
  }
}
