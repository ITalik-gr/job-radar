import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
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
/** Скільки прогін може висіти в `running`, поки не вважається обірваним. */
const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Прогін, який убили посеред роботи, лишався в статусі `running` назавжди. На сторінці
 * Джерела це виглядало як вічно живий запуск, а `hadResultsBefore` бачив запис без
 * результатів. Тому перед новим запуском старі підвислі закриваються як обірвані.
 */
async function closeStaleRuns(source: string): Promise<void> {
  const db = getDb();
  const cutoff = Date.now() - STALE_RUN_MS;

  const stale = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.source, source), eq(runs.status, 'running'), lt(runs.startedAt, cutoff)));

  if (stale.length === 0) return;

  for (const row of stale) {
    await db
      .update(runs)
      .set({ status: 'error', finishedAt: Date.now(), errors: ['прогін обірвано, процес не завершився'] })
      .where(eq(runs.id, row.id));
  }

  log.warn({ source, closed: stale.length }, 'закрито підвислі прогони');
}

export async function withRun<T extends RunResult>(
  source: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = getDb();
  await closeStaleRuns(source);
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

/**
 * Коли завдання востаннє відпрацювало без помилки. Потрібно наздоганянню:
 * без цього немає як відрізнити "щойно робили" від "не робили тиждень".
 *
 * Береться саме `finishedAt`, а не `startedAt`: обірваний прогін не рахується
 * за відпрацьований, інакше після падіння наздоганяння вирішило б, що все гаразд.
 */
export async function lastSuccessAt(source: string): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.source, source), eq(runs.status, 'ok'), isNotNull(runs.finishedAt)))
    .orderBy(desc(runs.finishedAt))
    .limit(1);

  return row?.finishedAt ?? null;
}

/**
 * Чи час запускати завдання. `null` у `lastSuccessAt` означає, що воно не
 * відпрацьовувало ніколи, і тоді запускати треба.
 */
export function isOverdue(lastAt: number | null, periodMs: number, now = Date.now()): boolean {
  if (lastAt === null) return true;
  return now - lastAt > periodMs;
}
