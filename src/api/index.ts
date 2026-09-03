import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { runs, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { listSources } from '../sources/registry.js';
import '../sources/index.js';
import {
  ACTIONS,
  applyAction,
  followUps,
  funnel,
  listOutreach,
  markReply,
  REPLY_TYPES,
  type Action,
  type ReplyType,
} from '../pipeline/actions.js';
import { remainingBudget } from '../pipeline/classify.js';
import { getQueue, pendingCount, todayKey } from '../pipeline/queue.js';
import { syncSource } from '../pipeline/sync.js';
import { fullStats } from '../pipeline/stats.js';
import { discover } from '../pipeline/discover.js';
import { syncDou, importFromBrowser } from '../pipeline/catalogs.js';
import { companiesRoutes } from './companies.js';
import { applyStudioAction, studioQueue, type StudioActionInput } from '../pipeline/studios.js';
import { recalcScores } from '../pipeline/recalc.js';
import { rules } from '../pipeline/rules.js';

export const app = new Hono();

// Інструмент локальний і однокористувацький, тому авторизації немає навмисно.
const WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Поки радар живе на localhost, авторизація не потрібна. Щойно він публічний,
 * без токена його база компаній і листування відкриті світу, тому перевірка
 * вмикається автоматично, коли RADAR_TOKEN заданий.
 */
export function requireToken(token: string | undefined) {
  return async (c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined; path: string; method: string } }, next: () => Promise<void>) => {
    if (!token || c.req.method === 'OPTIONS' || c.req.path === '/api/health') return next();

    const provided =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.header('x-radar-token') ??
      c.req.query('token');

    if (provided !== token) {
      throw Object.assign(new Error('немає або невірний токен'), { status: 401 });
    }
    return next();
  };
}

/**
 * Один обробник CORS на все: інтерфейс ходить із 5173, а збирач каталогів працює
 * у вкладці стороннього сайту, тому для /api/import дозволений будь-який origin.
 * Сервер слухає тільки localhost, назовні ці роути недоступні.
 */
app.use(
  '/api/*',
  cors({
    origin: (origin, c) =>
      c.req.path.startsWith('/api/import/') ? origin ?? '*' : WEB_ORIGINS.includes(origin) ? origin : null,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  }),
);

app.use('/api/*', async (c, next) => {
  const token = typeof process !== 'undefined' ? process.env.RADAR_TOKEN : undefined;
  return requireToken(token)(c, next);
});

app.get('/api/health', (c) => c.json({ ok: true, day: todayKey() }));

app.get('/api/queue', async (c) => {
  const day = c.req.query('day') ?? todayKey();
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const cards = await getQueue(day, limit);

  return c.json({
    day,
    pending: await pendingCount(day),
    total: cards.length,
    cards,
  });
});

app.post('/api/vacancies/:id/action', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{
    action: string;
    note?: string;
    days?: number;
    channel?: string;
    templateUsed?: string;
  }>();

  if (!ACTIONS.includes(body.action as Action)) {
    return c.json({ error: `невідома дія: ${body.action}` }, 400);
  }

  const result = await applyAction({
    vacancyId: id,
    action: body.action as Action,
    note: body.note ?? null,
    days: body.days,
    channel: body.channel,
    templateUsed: body.templateUsed ?? null,
  });

  return c.json(result);
});

app.post('/api/import/catalog', async (c) => {
  const body = await c.req.json<{ source?: string; pageUrl?: string; items?: unknown[] }>();
  const result = await importFromBrowser(body);
  log.info(
    { source: body.source, page: body.pageUrl, ...result },
    'сторінку каталогу прийнято з браузера',
  );
  return c.json(result);
});

app.get('/api/studios', async (c) => {
  const cards = await studioQueue({
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 25,
    minScore: c.req.query('min') ? Number(c.req.query('min')) : undefined,
    country: c.req.query('country'),
    search: c.req.query('q'),
    includeContacted: c.req.query('all') === '1',
  });
  return c.json({ threshold: rules().companies.threshold, cards });
});

app.post('/api/companies/:id/action', async (c) => {
  const body = await c.req.json<{ action: string; note?: string; days?: number; templateUsed?: string }>();
  const result = await applyStudioAction({
    companyId: Number(c.req.param('id')),
    action: body.action as StudioActionInput['action'],
    note: body.note ?? null,
    days: body.days,
    templateUsed: body.templateUsed ?? null,
  });
  return c.json(result);
});

app.post('/api/score/recalc', async (c) => c.json(await recalcScores()));

app.get('/api/rules', (c) => c.json(rules()));

app.route('/api/companies', companiesRoutes);

app.get('/api/outreach', async (c) => {
  const waiting = c.req.query('waiting');
  const rows = waiting ? await followUps(Number(waiting)) : await listOutreach();
  return c.json(rows);
});

app.post('/api/outreach/:id/reply', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ replyType: string; note?: string }>();

  if (!REPLY_TYPES.includes(body.replyType as ReplyType)) {
    return c.json({ error: `невідомий тип відповіді: ${body.replyType}` }, 400);
  }

  await markReply(id, body.replyType as ReplyType, body.note ?? null);
  return c.json({ ok: true });
});

app.get('/api/sources', async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      source: runs.source,
      status: runs.status,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      itemsFound: runs.itemsFound,
      itemsNew: runs.itemsNew,
      errors: runs.errors,
    })
    .from(runs)
    .orderBy(desc(runs.startedAt));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.source)) latest.set(row.source, row);

  return c.json(
    listSources().map((source) => ({
      id: source.id,
      kind: source.kind,
      requiresSlug: 'requiresSlug' in source ? Boolean(source.requiresSlug) : false,
      lastRun: latest.get(source.id) ?? null,
    })),
  );
});

app.post('/api/sources/:id/run', async (c) => {
  const id = c.req.param('id');
  const body: { limit?: number; skipLlm?: boolean } = await c.req
    .json<{ limit?: number; skipLlm?: boolean }>()
    .catch(() => ({}));
  const result = await syncSource(id, { limit: body.limit, skipLlm: body.skipLlm });
  return c.json(result);
});

app.get('/api/stats', async (c) => {
  const db = getDb();
  const [scores] = await db
    .select({
      total: sql<number>`count(*)`,
      open: sql<number>`sum(case when ${vacancies.closedAt} is null then 1 else 0 end)`,
      aboveThreshold: sql<number>`sum(case when ${vacancies.score} >= ${config.pipeline.scoreThreshold} then 1 else 0 end)`,
      stopped: sql<number>`sum(case when ${vacancies.score} = -100 then 1 else 0 end)`,
      needsReview: sql<number>`sum(case when ${vacancies.needsReview} = 1 then 1 else 0 end)`,
    })
    .from(vacancies);

  return c.json({
    vacancies: scores,
    funnel: await funnel(),
    llmBudgetLeft: await remainingBudget(),
    threshold: config.pipeline.scoreThreshold,
  });
});

app.get('/api/stats/full', async (c) => c.json(await fullStats()));

app.post('/api/discover', async (c) => {
  const body: { limit?: number } = await c.req.json<{ limit?: number }>().catch(() => ({}));
  return c.json(await discover({ limit: body.limit ?? 25 }));
});

app.post('/api/catalogs/dou/run', async (c) => {
  const body: { limit?: number } = await c.req.json<{ limit?: number }>().catch(() => ({}));
  return c.json(await syncDou({ limit: body.limit ?? 40 }));
});

/**
 * Вебхук телеграма для задеплоєної версії. Вмикається один раз:
 * https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<воркер>/api/telegram/webhook
 */
app.post('/api/telegram/webhook', async (c) => {
  const { webhookCallback } = await import('grammy');
  const { buildBot, isConfigured: telegramReady } = await import('../notify/telegram.js');
  if (!telegramReady()) return c.json({ error: 'телеграм не налаштований' }, 400);
  return webhookCallback(buildBot(), 'hono')(c);
});

app.get('/api/vacancies/:id', async (c) => {
  const db = getDb();
  const [row] = await db.select().from(vacancies).where(eq(vacancies.id, Number(c.req.param('id'))));
  return row ? c.json(row) : c.json({ error: 'вакансії немає' }, 404);
});

app.onError((error, c) => {
  const status = (error as { status?: number }).status ?? 500;
  if (status !== 401) log.error({ err: error.message, path: c.req.path }, 'помилка API');
  return c.json({ error: error.message }, status as 401 | 500);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  log.info({ port }, 'API запущено');
}
