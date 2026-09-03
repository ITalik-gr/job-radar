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

/** Розклад з CLAUDE.md, розділ 8. Все всередині одного процесу, без черг і Docker. */
export const SCHEDULE = {
  ats: '0 */6 * * *',
  careersInteresting: '30 3 * * *',
  catalogs: '0 4 * * 1',
  discovery: '0 5 * * 2',
  digest: '0 10 * * *',
  followUps: '0 18 * * *',
} as const;

async function safely(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ task: name, err: message }, 'завдання за розкладом впало');
    await notify.raw(`Завдання <b>${name}</b> впало: ${message}`).catch(() => undefined);
  }
}

async function runBoards(): Promise<void> {
  for (const source of listSources('board')) {
    await safely(`sync:${source.id}`, () => syncSource(source.id));
  }
  await safely('classify:pending', () => classifyPending(50));
  await safely('notify:highScore', () => notify.highScore());
  await safely('notify:broken', () => notify.broken());
}

export function startScheduler(): void {
  const timezone = process.env.TZ ?? 'Europe/Kyiv';

  cron.schedule(SCHEDULE.ats, () => void runBoards(), { timezone });
  cron.schedule(SCHEDULE.catalogs, () => void safely('catalog:dou', () => syncDou({ limit: 60 })), { timezone });
  cron.schedule(SCHEDULE.discovery, () => void safely('discover', () => discover({ limit: 40 })), { timezone });
  cron.schedule(SCHEDULE.digest, () => void safely('notify:digest', () => notify.digest()), { timezone });
  cron.schedule(SCHEDULE.followUps, () => void safely('notify:followUps', () => notify.followUps()), { timezone });

  log.info(
    { timezone, schedule: SCHEDULE, llmLimit: config.llm.dailyCallLimit },
    'планувальник запущено',
  );
}
