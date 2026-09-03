import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { runs } from '../db/schema.js';
import { log } from './log.js';

export interface RunResult {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
}

/**
 * Обгортка навколо запуску адаптера. Правило проєкту: нуль записів там, де раніше
 * було більше нуля, це WARN, а не успіх. Мовчазна поломка скрейпера найдорожча.
 */
export async function withRun<T extends RunResult>(
  source: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = getDb();
  const [row] = await db.insert(runs).values({ source, status: 'running' }).returning({ id: runs.id });
  const runId = row!.id;

  try {
    const result = await fn();
    const degraded = result.itemsFound === 0 && (await hadResultsBefore(source, runId));
    const status = result.errors.length > 0 || degraded ? 'warn' : 'ok';

    await db
      .update(runs)
      .set({
        finishedAt: Date.now(),
        itemsFound: result.itemsFound,
        itemsNew: result.itemsNew,
        errors: result.errors,
        status,
      })
      .where(eq(runs.id, runId));

    if (degraded) {
      log.warn({ source, runId }, 'адаптер повернув нуль записів, хоча раніше повертав більше нуля');
    } else {
      log.info(
        { source, runId, found: result.itemsFound, new: result.itemsNew, errors: result.errors.length },
        'запуск завершено',
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(runs)
      .set({ finishedAt: Date.now(), status: 'error', errors: [message] })
      .where(eq(runs.id, runId));
    log.error({ source, runId, err: message }, 'запуск впав');
    throw error;
  }
}

async function hadResultsBefore(source: string, currentRunId: number): Promise<boolean> {
  const db = getDb();
  const previous = await db
    .select({ itemsFound: runs.itemsFound })
    .from(runs)
    .where(and(eq(runs.source, source), isNotNull(runs.finishedAt)))
    .orderBy(desc(runs.startedAt))
    .limit(5);
  return previous.filter((r) => r.itemsFound > 0).length > 0 && currentRunId > 0;
}
