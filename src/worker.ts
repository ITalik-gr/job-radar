import { drizzle } from 'drizzle-orm/d1';
import { app } from './api/index.js';
import { config, setRuntimeEnv } from './config.js';
import { rotate } from './lib/rotate.js';
import { setDb, schema } from './db/client.js';
import { log } from './lib/log.js';
import { listSources } from './sources/registry.js';
import './sources/index.js';
import { syncSource } from './pipeline/sync.js';
import { syncCatalog, syncDou } from './pipeline/catalogs.js';
import { syncAllLeads } from './pipeline/leads.js';
import { discover } from './pipeline/discover.js';
import { enrich } from './pipeline/enrich.js';
import { notify } from './notify/telegram.js';
import { refreshRulesFromDb } from './pipeline/rules.js';
import { setAiBinding } from './lib/workers-ai.js';
import { checkReplies } from './pipeline/replies.js';
import { prepareFollowups } from './pipeline/followups.js';
import { oauthProvider } from './mcp/oauth.js';
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
   * Workers AI. Company vectors are always computed here, and model calls are too when
   * `LLM_PROVIDER=workers-ai`: this uses the paid plan's included quota instead of a
   * separate bill for Anthropic tokens.
   */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  RADAR_TOKEN?: string;
  /** Grants and tokens of the MCP OAuth flow, see src/mcp/oauth.ts. */
  OAUTH_KV?: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
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
    // A few sites per run: each is several pages, all subrequests under the same ceiling.
    await safely('enrich', () => enrich({ limit: 10 }));
    return;
  }

  if (cron === '0 4 * * 1') {
    await safely('catalog:dou', () => syncDou({ limit: 60 }));
    // Without a key the source is off on purpose, which is not worth a failed run every week.
    if (config.places.apiKey) await safely('catalog:places', () => syncCatalog('places'));
    return;
  }
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
  if (cron === '30 6 * * *') {
    await safely('outreach:followups', () => prepareFollowups());
    // Tenders and funding news once a day: a tender lives for a week or two, news for a day.
    await safely('leads', () => syncAllLeads());
    return;
  }

  log.warn({ cron }, 'unknown schedule');
}

/** The site and the API: everything except the MCP endpoint and the OAuth protocol routes. */
const site = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Rules changed from the interface live in the database. The isolate between
    // requests can be new, so they get re-read before processing: otherwise scoring
    // would run on the baked-in config and editing the threshold would change nothing.
    await refreshRulesFromDb();

    return app.fetch(request, env, ctx);
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    prepare(env);

    const url = new URL(request.url);

    /*
     * Locally an empty token means "no password", and that is fine on loopback. On a worker it
     * meant the contacts, the letters and the send button were open to the internet, for
     * example after a plain `pnpm deploy` without `cf:setup`. So the worker fails closed, the
     * OAuth flow included: its consent page checks this very token.
     */
    if (!config.token && url.pathname !== '/api/health') {
      return Response.json(
        { error: 'RADAR_TOKEN is not set on this worker: pnpm wrangler secret put RADAR_TOKEN' },
        { status: 503 },
      );
    }

    /*
     * Without the KV namespace there is no OAuth, and /mcp falls back to the plain bearer check
     * in the Hono app, so Claude Code keeps working on a fork that never created the namespace.
     */
    if (!env.OAUTH_KV) {
      if (url.pathname === '/mcp') return app.fetch(request, env, ctx);
      return site.fetch(request, env, ctx);
    }

    const provider = oauthProvider(url.origin, {
      prepare: async () => {
        await refreshRulesFromDb();
      },
      site: site as never,
    });
    return provider.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    prepare(env);
    ctx.waitUntil(refreshRulesFromDb().then(() => runSchedule(event.cron)));
  },
};
