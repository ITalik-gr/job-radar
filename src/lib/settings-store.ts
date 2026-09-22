import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { log } from './log.js';

/**
 * A simple JSON store on top of the `settings` table.
 *
 * The table already exists for scoring rules, and there is no need to invent a
 * second place for small long-lived state. Used where data is expensive to fetch
 * again but almost never changes: for example the mapping from a company's slug on
 * a vacancy board to its real domain.
 */
export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
    return row ? (row.value as T) : fallback;
  } catch (error) {
    // A missing store must not fail the run: work without the cache.
    log.warn({ key, err: String(error) }, 'settings could not be read');
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
    log.warn({ key, err: String(error) }, 'settings could not be saved');
  }
}
