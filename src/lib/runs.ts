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
 * A wrapper around running an adapter. Project rule: zero records where there used
 * to be more than zero is a WARN, not a success. A silent scraper breakage is the
 * most expensive kind.
 */
/** How long a run can sit in `running` before it counts as interrupted. */
const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * A run killed mid-work used to stay in the `running` status forever. On the Sources
 * page that looked like an eternally alive run, and `hadResultsBefore` saw a record
 * with no results. So before a new run starts, old stuck ones get closed as interrupted.
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
      .set({ status: 'error', finishedAt: Date.now(), errors: ['run interrupted, the process did not finish'] })
      .where(eq(runs.id, row.id));
  }

  log.warn({ source, closed: stale.length }, 'closed stuck runs');
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
      log.warn({ source, runId }, 'adapter returned zero records, though it used to return more than zero');
    } else {
      log.info(
        { source, runId, found: result.itemsFound, new: result.itemsNew, errors: result.errors.length },
        'run finished',
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(runs)
      .set({ finishedAt: Date.now(), status: 'error', errors: [message] })
      .where(eq(runs.id, runId));
    log.error({ source, runId, err: message }, 'run crashed');
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
 * When a task last ran without an error. Needed for catch-up: without it there is no
 * way to tell "just ran" apart from "hasn't run in a week".
 *
 * It is specifically `finishedAt`, not `startedAt`, that is taken: an interrupted run
 * does not count as completed, otherwise catch-up would decide everything is fine
 * after a crash.
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
 * Whether it is time to run the task. `null` in `lastSuccessAt` means it has never
 * run successfully, and then it must run.
 */
export function isOverdue(lastAt: number | null, periodMs: number, now = Date.now()): boolean {
  if (lastAt === null) return true;
  return now - lastAt > periodMs;
}
