import { drizzle } from 'drizzle-orm/d1';
import { app } from './api/index.js';
import { setRuntimeEnv } from './config.js';
import { setDb, schema } from './db/client.js';
import { log } from './lib/log.js';
import { listSources } from './sources/registry.js';
import './sources/index.js';
import { syncSource } from './pipeline/sync.js';
import { syncDou } from './pipeline/catalogs.js';
import { discover } from './pipeline/discover.js';
import { classifyPending } from './pipeline/reclassify.js';
import { notify } from './notify/telegram.js';
import { refreshRulesFromDb } from './pipeline/rules.js';

/**
 * Точка входу для Cloudflare Workers. Той самий Hono-застосунок, що й локально,
 * плюс планувальник на Cron Triggers замість node-cron.
 *
 * База приходить біндінгом D1 на кожен запит, тому інстанс підставляється перед
 * обробкою: у Workers немає довгоживучого процесу, куди її можна покласти один раз.
 */
export interface Env {
  DB: D1Database;
  RADAR_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEB_URL?: string;
  ASSETS?: Fetcher;
}

function prepare(env: Env): void {
  // Секрети і біндінги приходять на кожен запит, тому конфіг і база ставляться тут.
  setRuntimeEnv(env as unknown as Record<string, unknown>);
  if (!env.DB) throw new Error('немає біндінгу D1 з іменем DB, перевір wrangler.jsonc');
  setDb(drizzle(env.DB, { schema }));
}

async function safely(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ task: name, err: message }, 'завдання за розкладом впало');
    await notify.raw(`Завдання <b>${name}</b> впало: ${message}`).catch(() => undefined);
  }
}

/** Розклад узгоджений із wrangler.jsonc: щогодини вирішуємо, що саме робити. */
async function runSchedule(cron: string): Promise<void> {
  if (cron === '0 */6 * * *') {
    for (const source of listSources('board')) {
      await safely(`sync:${source.id}`, () => syncSource(source.id));
    }
    await safely('classify:pending', () => classifyPending(50));
    await safely('notify:highScore', () => notify.highScore());
    await safely('notify:broken', () => notify.broken());
    return;
  }

  if (cron === '0 4 * * 1') return safely('catalog:dou', () => syncDou({ limit: 60 }));
  if (cron === '0 5 * * 2') return safely('discover', () => discover({ limit: 40 }));
  if (cron === '0 10 * * *') return safely('notify:digest', () => notify.digest());
  if (cron === '0 18 * * *') return safely('notify:followUps', () => notify.followUps());

  log.warn({ cron }, 'невідомий розклад');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    prepare(env);

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Правила, змінені з інтерфейсу, лежать у базі. Ізолят між запитами може бути
    // новим, тому перечитуємо перед обробкою: інакше скоринг рахував би за вшитим
    // конфігом і правка порогу нічого б не змінила.
    await refreshRulesFromDb();

    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    prepare(env);
    ctx.waitUntil(refreshRulesFromDb().then(() => runSchedule(event.cron)));
  },
};
