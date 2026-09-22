import cron from 'node-cron';
import './db/client.node.js';
import { config } from './config.js';
import { log } from './lib/log.js';
import { listSources } from './sources/registry.js';
import './sources/index.js';
import { syncSource } from './pipeline/sync.js';
import { syncDou } from './pipeline/catalogs.js';
import { discover } from './pipeline/discover.js';
import { classifyPending } from './pipeline/reclassify.js';
import { notify } from './notify/telegram.js';
import { isOverdue, lastSuccessAt } from './lib/runs.js';
import { checkReplies } from './pipeline/replies.js';
import { prepareFollowups } from './pipeline/followups.js';
import './lib/gmail-store.node.js';

/** The schedule from CLAUDE.md, section 8. All inside one process, no queues, no Docker. */
export const SCHEDULE = {
  ats: '0 */6 * * *',
  careersInteresting: '30 3 * * *',
  catalogs: '0 4 * * 1',
  discovery: '0 5 * * 2',
  /**
   * The only Telegram message: one summary on Monday and Thursday. Daily digests and alerts
   * every 6 hours came several at a time and turned the bot into noise.
   */
  summary: '0 10 * * 1,4',
  /** Replies and bounces. Hourly: sooner has no point, later and the pace is lost. */
  replies: '5 * * * *',
  /** Follow-up drafts get prepared in the morning, so they are already in the list by 10:00. */
  followupDrafts: '30 9 * * *',
} as const;

async function safely(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log only, no Telegram push: an hourly task failing would otherwise message every hour.
    log.error({ task: name, err: message }, 'scheduled task crashed');
  }
}

async function runBoards(): Promise<void> {
  for (const source of listSources('board')) {
    await safely(`sync:${source.id}`, () => syncSource(source.id));
  }
  await safely('classify:pending', () => classifyPending(50));
}

/**
 * Task periods for catch-up. Must match `SCHEDULE` above: if the schedule changes
 * and this does not, catch-up will either stay silent or run unnecessary work.
 *
 * `source` is the name a task writes to the `runs` table under. For the board run we
 * take greenhouse: it goes first in the batch, and if it succeeded, the batch started.
 */
const CATCH_UP: { name: string; source: string; periodMs: number; run: () => Promise<unknown> }[] = [
  { name: 'boards', source: 'greenhouse', periodMs: 6 * 60 * 60 * 1000, run: runBoards },
  {
    name: 'catalog:dou',
    source: 'dou',
    periodMs: 7 * 24 * 60 * 60 * 1000,
    run: () => syncDou({ limit: 60 }),
  },
  {
    name: 'discover',
    source: 'discover',
    periodMs: 7 * 24 * 60 * 60 * 1000,
    run: () => discover({ limit: 40 }),
  },
];

/**
 * Catching up on what was missed.
 *
 * node-cron does not run what it missed while the process was down, and it is down
 * every night and whenever the laptop is closed. Without this, a "every 6 hours"
 * schedule in practice meant "whenever the laptop happened to be on at a round hour".
 *
 * Runs one task at a time with a pause between them: otherwise, after a week-long
 * gap, all three would start at once and hit other people's sites together.
 */
export async function catchUp(delayBetweenMs = 30_000): Promise<string[]> {
  const done: string[] = [];

  for (const task of CATCH_UP) {
    const last = await lastSuccessAt(task.source);
    if (!isOverdue(last, task.periodMs)) continue;

    log.info(
      { task: task.name, lastAt: last ? new Date(last).toISOString() : 'never' },
      'catching up on a missed run',
    );
    await safely(`catchUp:${task.name}`, task.run);
    done.push(task.name);

    if (delayBetweenMs > 0) await new Promise((resolve) => setTimeout(resolve, delayBetweenMs));
  }

  if (done.length === 0) log.info('nothing to catch up on, the schedule was not behind');
  return done;
}

export function startScheduler(): void {
  const timezone = process.env.TZ ?? 'Europe/Kyiv';

  cron.schedule(SCHEDULE.ats, () => void runBoards(), { timezone });
  cron.schedule(SCHEDULE.catalogs, () => void safely('catalog:dou', () => syncDou({ limit: 60 })), { timezone });
  cron.schedule(SCHEDULE.discovery, () => void safely('discover', () => discover({ limit: 40 })), { timezone });
  cron.schedule(SCHEDULE.summary, () => void safely('notify:summary', () => notify.summary()), { timezone });

  /*
   * Outreach lives only locally: the Gmail token sits as a file on the laptop, and
   * on Workers these two tasks do not exist. If mail is not connected, both do
   * nothing silently, so there is no need to gate them behind a separate flag.
   */
  cron.schedule(
    SCHEDULE.replies,
    () => void safely('outreach:replies', () => checkReplies({ ownEmail: config.gmail.fromEmail })),
    { timezone },
  );
  cron.schedule(
    SCHEDULE.followupDrafts,
    () => void safely('outreach:followups', () => prepareFollowups()),
    { timezone },
  );

  log.info(
    { timezone, schedule: SCHEDULE, llmLimit: config.llm.dailyCallLimit },
    'scheduler started',
  );

  // Not blocking process startup: the API must come up immediately, catch-up can wait a minute.
  setTimeout(() => void catchUp(), 60_000).unref?.();
}
