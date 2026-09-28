import { drizzle } from 'drizzle-orm/d1';
import { app } from './api/index.js';
import { config, setRuntimeEnv } from './config.js';
import { rotate } from './lib/rotate.js';
import { setDb, schema } from './db/client.js';
import { log } from './lib/log.js';
import { listSources } from './sources/registry.js';
import './sources/index.js';
import { syncSource } from './pipeline/sync.js';
import { syncCareers } from './pipeline/careers.js';
import { syncDou } from './pipeline/catalogs.js';
import { discover } from './pipeline/discover.js';
import { classifyPending } from './pipeline/reclassify.js';
import { notify } from './notify/telegram.js';
import { refreshRulesFromDb } from './pipeline/rules.js';
import { setAiBinding } from './lib/workers-ai.js';
import { checkReplies } from './pipeline/replies.js';
import { prepareFollowups } from './pipeline/followups.js';
// The Gmail token on Workers arrives as a secret, there is no file system here.
import './lib/gmail-store.env.js';

/**
 * Entry point for Cloudflare Workers. The same Hono app as locally, plus a scheduler
 * on Cron Triggers instead of node-cron.
 *
 * The database arrives as a D1 binding on every request, so the instance gets set
 * before processing: on Workers there is no long-lived process to put it into once.
 */
export interface Env {
  DB: D1Database;
  /**
   * Workers AI. Company vectors are always computed here, and classification is too
   * when `LLM_PROVIDER=workers-ai`: this uses the paid plan's included quota instead
   * of a separate bill for Anthropic tokens.
   */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  RADAR_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  /** The model for the letter's first paragraph. Empty means the same one as classification. */
  OUTREACH_MODEL?: string;
  LLM_PROVIDER?: string;
  WORKERS_AI_MODEL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEB_URL?: string;
  ASSETS?: Fetcher;
}

function prepare(env: Env): void {
  // Secrets and bindings arrive on every request, so the config and the database get set here.
  setRuntimeEnv(env as unknown as Record<string, unknown>);
  if (!env.DB) throw new Error('no D1 binding named DB, check wrangler.jsonc');
  setDb(drizzle(env.DB, { schema }));
  // On Workers both vectors and classification go through the binding, with no token and no outbound access.
  if (env.AI) setAiBinding(env.AI);
}

async function safely(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log only, no Telegram push: an hourly task failing would otherwise message every hour.
    log.error({ task: name, err: message }, 'scheduled task crashed');
  }
}

/** Schedule kept in sync with wrangler.jsonc: every hour we decide exactly what to do. */
async function runSchedule(cron: string): Promise<void> {
  if (cron === '0 */6 * * *') {
    /*
     * The order rotates with every run. One invocation has a subrequest ceiling, and with a
     * fixed order the sources at the end of the list were the ones that never got their turn
     * once the ceiling hit. Rotating spreads that loss instead of always starving the same tail.
     */
    for (const source of rotate(listSources('board'), Math.floor(Date.now() / (6 * 3_600_000)))) {
      await safely(`sync:${source.id}`, () => syncSource(source.id));
    }
    // Few career pages per run: each one is a page plus detail pages, all subrequests.
    await safely('careers', () => syncCareers({ limit: 10 }));
    await safely('classify:pending', () => classifyPending(50));
    return;
  }

  if (cron === '0 4 * * 1') return safely('catalog:dou', () => syncDou({ limit: 60 }));
  if (cron === '0 5 * * 2') return safely('discover', () => discover({ limit: 40 }));
  // The only Telegram message: Monday and Thursday, 07:00 UTC is 10:00 in Kyiv (summer time).
  if (cron === '0 7 * * MON,THU') return safely('notify:summary', () => notify.summary());

  /*
   * Outreach. Time in Cron Triggers is always UTC, so 06:30 UTC is 09:30 in Kyiv:
   * follow-up drafts must be ready before the digest, not after it.
   */
  if (cron === '5 * * * *') {
    return safely('outreach:replies', () => checkReplies({ ownEmail: config.gmail.fromEmail }));
  }
  if (cron === '30 6 * * *') return safely('outreach:followups', () => prepareFollowups());

  log.warn({ cron }, 'unknown schedule');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    prepare(env);

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    /*
     * Locally an empty token means "no password", and that is fine on loopback. On a worker it
     * meant the contacts, the letters and the send button were open to the internet, for
     * example after a plain `pnpm deploy` without `cf:setup`. So the worker fails closed.
     */
    if (!config.token && url.pathname !== '/api/health') {
      return Response.json(
        { error: 'RADAR_TOKEN is not set on this worker: pnpm wrangler secret put RADAR_TOKEN' },
        { status: 503 },
      );
    }

    // Rules changed from the interface live in the database. The isolate between
    // requests can be new, so they get re-read before processing: otherwise scoring
    // would run on the baked-in config and editing the threshold would change nothing.
    await refreshRulesFromDb();

    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    prepare(env);
    ctx.waitUntil(refreshRulesFromDb().then(() => runSchedule(event.cron)));
  },
};
