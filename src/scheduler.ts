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

/** Розклад з CLAUDE.md, розділ 8. Все всередині одного процесу, без черг і Docker. */
export const SCHEDULE = {
  ats: '0 */6 * * *',
  careersInteresting: '30 3 * * *',
  catalogs: '0 4 * * 1',
  discovery: '0 5 * * 2',
  digest: '0 10 * * *',
  followUps: '0 18 * * *',
  /** Відповіді і баунси. Щогодини: раніше нема сенсу, пізніше втрачається темп. */
  replies: '5 * * * *',
  /** Чернетки фолоу-апів готуються зранку, щоб о 10:00 вони вже були в списку. */
  followupDrafts: '30 9 * * *',
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

/**
 * Періоди завдань для наздоганяння. Мають відповідати `SCHEDULE` вище: якщо
 * розклад змінили, а тут ні, наздоганяння або мовчатиме, або ганятиме зайве.
 *
 * `source` це те, під яким іменем завдання пише в таблицю `runs`. Для прогону
 * бордів беремо greenhouse: він іде першим у пачці, і якщо відпрацював, значить
 * пачка стартувала.
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
 * Наздоганяння пропущеного.
 *
 * node-cron не відпрацьовує те, що пропустив, поки процес не працював, а він
 * не працює щоночі і щоразу, коли ноут закритий. Без цього розклад "кожні 6 годин"
 * на практиці означав "коли ноут випадково був увімкнений о рівній годині".
 *
 * Запускається по одному завданню за раз і з паузою: інакше після тижневої перерви
 * усі три стартують одночасно і разом лізуть до чужих сайтів.
 */
export async function catchUp(delayBetweenMs = 30_000): Promise<string[]> {
  const done: string[] = [];

  for (const task of CATCH_UP) {
    const last = await lastSuccessAt(task.source);
    if (!isOverdue(last, task.periodMs)) continue;

    log.info(
      { task: task.name, lastAt: last ? new Date(last).toISOString() : 'ніколи' },
      'наздоганяю пропущений запуск',
    );
    await safely(`catchUp:${task.name}`, task.run);
    done.push(task.name);

    if (delayBetweenMs > 0) await new Promise((resolve) => setTimeout(resolve, delayBetweenMs));
  }

  if (done.length === 0) log.info('наздоганяти нічого, розклад не відставав');
  return done;
}

export function startScheduler(): void {
  const timezone = process.env.TZ ?? 'Europe/Kyiv';

  cron.schedule(SCHEDULE.ats, () => void runBoards(), { timezone });
  cron.schedule(SCHEDULE.catalogs, () => void safely('catalog:dou', () => syncDou({ limit: 60 })), { timezone });
  cron.schedule(SCHEDULE.discovery, () => void safely('discover', () => discover({ limit: 40 })), { timezone });
  cron.schedule(SCHEDULE.digest, () => void safely('notify:digest', () => notify.digest()), { timezone });
  cron.schedule(SCHEDULE.digest, () => void safely('notify:outreach', () => notify.outreach()), { timezone });
  cron.schedule(SCHEDULE.followUps, () => void safely('notify:followUps', () => notify.followUps()), { timezone });

  /*
   * Розсилка живе тільки локально: токен Gmail лежить файлом на ноутбуці, і на
   * Workers цих двох задач немає. Якщо пошта не підключена, обидві мовчки нічого
   * не роблять, тому вмикати їх окремим прапорцем не треба.
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
    'планувальник запущено',
  );

  // Не блокуємо старт процесу: API має піднятись одразу, а наздоганяння почекає хвилину.
  setTimeout(() => void catchUp(), 60_000).unref?.();
}
