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
import { getQueue, pendingCount, todayKey, topUpQueue } from '../pipeline/queue.js';
import { toCsv } from '../lib/csv.js';
import { embedCompanies, similarCompanies } from '../pipeline/similar.js';
import { syncSource } from '../pipeline/sync.js';
import { fullStats } from '../pipeline/stats.js';
import { discover } from '../pipeline/discover.js';
import { enrich } from '../pipeline/enrich.js';
import { syncDou, importFromBrowser } from '../pipeline/catalogs.js';
import { companiesRoutes } from './companies.js';
import { applyStudioAction, studioPage, type StudioActionInput } from '../pipeline/studios.js';
import { recalcScores } from '../pipeline/recalc.js';
import { resetRules, rules, rulesSource, saveRules } from '../pipeline/rules.js';
import {
  TEMPLATE_KINDS,
  archiveTemplate,
  createTemplate,
  listTemplates,
  seedTemplates,
  updateTemplate,
} from '../pipeline/templates.js';

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

app.use('/api/*', async (c, next) => requireToken(config.token)(c, next));

/**
 * Здоровʼя. З `?deep=1` ще й перевіряє базу: на проді найчастіша причина падінь це
 * незастосовані міграції, і тоді будь-який запит валиться з "no such table".
 */
app.get('/api/health', async (c) => {
  const base = { ok: true, day: todayKey() };
  if (c.req.query('deep') !== '1') return c.json(base);

  try {
    const rows = await getDb().all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' order by name`,
    );
    const tables = rows.map((row) => row.name).filter((name) => !name.startsWith('sqlite_'));
    const expected = [
      'companies',
      'company_state',
      'contacts',
      'llm_cache',
      'llm_usage',
      'outreach',
      'queue_items',
      'runs',
      'settings',
      'snapshots',
      'templates',
      'vacancies',
    ];
    const missing = expected.filter((name) => !tables.includes(name));

    return c.json({
      ...base,
      db: missing.length === 0 ? 'ok' : 'міграції не застосовані',
      tables,
      missing,
      hint: missing.length === 0 ? null : 'pnpm wrangler d1 migrations apply job-radar --remote',
    });
  } catch (error) {
    return c.json({ ...base, ok: false, db: 'помилка', error: describe(error) }, 500);
  }
});

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

/**
 * Добрати картки в сьогоднішній зріз. Саме дія власника, а не автоматика:
 * зріз навмисно фіксований, інакше нова вакансія з вищим рахунком витісняла б ту,
 * яку ще не встигли подивитись.
 */
app.post('/api/queue/top-up', async (c) => c.json(await topUpQueue()));

/**
 * Вивантаження у CSV прямо з інтерфейсу. Віддається як файл, тому браузер його
 * одразу зберігає, а не показує текстом.
 */
app.get('/api/export/:what', async (c) => {
  const what = c.req.param('what');
  const named = c.req.query('named') === '1';

  let rows: Record<string, unknown>[] = [];

  if (what === 'queue') {
    rows = (await getQueue(todayKey())).map((card) => ({
      компанія: card.company,
      домен: card.domain,
      вакансія: card.title,
      рахунок: card.score,
      грейд: card.seniority,
      локація: card.location,
      вилка: [card.salaryMin, card.salaryMax].filter(Boolean).join(' - '),
      стек: card.stack.join(' '),
      посилання: card.url,
      рішення: card.decision ?? '',
    }));
  } else if (what === 'studios') {
    const page = await studioPage({ limit: 1000, withNamedContact: named });
    rows = page.cards.map((card) => ({
      компанія: card.name,
      домен: card.domain,
      тип: card.kind,
      рахунок: card.score,
      де: [card.city, card.country].filter(Boolean).join(', '),
      контакт: card.contacts.find((contact) => contact.name)?.name ?? '',
      посада: card.contacts.find((contact) => contact.name)?.role ?? '',
      пошта:
        card.contacts.find((contact) => contact.name && contact.email)?.email ??
        card.contacts.find((contact) => contact.email)?.email ??
        '',
      вакансій: card.openVacancies,
      оцінка: card.rating ?? '',
      відгуків: card.reviewsCount ?? '',
      ставка: card.hourlyRate ?? '',
      мінімальний_проєкт: card.minProject ?? '',
    }));
  } else {
    return c.json({ error: `невідомий тип вивантаження: ${what}` }, 400);
  }

  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="job-radar-${what}-${todayKey()}.csv"`,
    },
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
    contactName?: string;
    contactEmail?: string;
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
    contactName: body.contactName ?? null,
    contactEmail: body.contactEmail ?? null,
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
  // Ліміт свідомо високий: список студій це основний робочий інструмент власника,
  // і 25 записів на 300 компаній у базі виглядали так, ніби збір не працює.
  // Уся видача важить близько 300 КБ, для локального інструмента це нічого.
  const page = await studioPage({
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 1000,
    minScore: c.req.query('min') ? Number(c.req.query('min')) : undefined,
    country: c.req.query('country'),
    search: c.req.query('q'),
    kind: c.req.query('kind'),
    withNamedContact: c.req.query('named') === '1',
    minRating: c.req.query('rating') ? Number(c.req.query('rating')) : undefined,
    includeContacted: c.req.query('all') === '1',
  });
  return c.json(page);
});

app.post('/api/companies/:id/action', async (c) => {
  const body = await c.req.json<{
    action: string;
    note?: string;
    days?: number;
    templateUsed?: string;
    contactName?: string;
    contactEmail?: string;
  }>();
  const result = await applyStudioAction({
    companyId: Number(c.req.param('id')),
    action: body.action as StudioActionInput['action'],
    note: body.note ?? null,
    days: body.days,
    templateUsed: body.templateUsed ?? null,
    contactName: body.contactName ?? null,
    contactEmail: body.contactEmail ?? null,
  });
  return c.json(result);
});

app.post('/api/score/recalc', async (c) => c.json(await recalcScores()));

/*
 * Правила відбору і шаблони листів правляться з інтерфейсу, а не тільки з файла.
 * На Workers файлової системи немає, тому без цих роутів на проді не змінити ні
 * поріг, ні стоп-слова, ні текст листа: тільки новим деплоєм.
 */

app.get('/api/rules', (c) => c.json({ rules: rules(), source: rulesSource() }));

app.put('/api/rules', async (c) => {
  const body = (await c.req.json()) as unknown;
  const saved = await saveRules(body);
  return c.json({ rules: saved, source: rulesSource() });
});

app.post('/api/rules/reset', async (c) => {
  const restored = await resetRules();
  return c.json({ rules: restored, source: rulesSource() });
});

/**
 * Дрібні правки одним кліком: побачив тег у вакансії і одразу відправив його
 * у стоп-слова або дав вагу. Повний обʼєкт правил при цьому не гоняється туди-сюди.
 */
app.post('/api/rules/stop-words', async (c) => {
  const { word, remove } = (await c.req.json()) as { word?: string; remove?: boolean };
  const value = word?.trim().toLowerCase();
  if (!value) return c.json({ error: 'потрібне слово' }, 400);

  const current = rules();
  const set = new Set(current.stopWords);
  if (remove) set.delete(value);
  else set.add(value);

  const saved = await saveRules({ ...current, stopWords: [...set].sort() });
  return c.json({ rules: saved, source: rulesSource() });
});

app.post('/api/rules/weights', async (c) => {
  const { term, weight } = (await c.req.json()) as { term?: string; weight?: number | null };
  const value = term?.trim().toLowerCase();
  if (!value) return c.json({ error: 'потрібен термін' }, 400);

  const current = rules();
  const terms = { ...current.weights.terms };
  if (weight === null || weight === undefined) delete terms[value];
  else terms[value] = weight;

  const saved = await saveRules({ ...current, weights: { ...current.weights, terms } });
  return c.json({ rules: saved, source: rulesSource() });
});

app.get('/api/templates', async (c) => {
  await seedTemplates();
  return c.json({ kinds: TEMPLATE_KINDS, templates: await listTemplates(c.req.query('kind')) });
});

app.post('/api/templates', async (c) => {
  const body = (await c.req.json()) as { name?: string };
  if (!body.name?.trim()) return c.json({ error: 'потрібна назва' }, 400);
  return c.json(await createTemplate(body as { name: string }));
});

app.patch('/api/templates/:id', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  return c.json(await updateTemplate(Number(c.req.param('id')), body));
});

app.delete('/api/templates/:id', async (c) => c.json(await archiveTemplate(Number(c.req.param('id')))));

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
    // Видно, хто саме класифікує: рахунок за токени Anthropic чи квота Workers AI.
    llmProvider: config.llm.provider,
    llmModel: config.llm.activeModel,
    threshold: config.pipeline.scoreThreshold,
  });
});

app.get('/api/stats/full', async (c) => c.json(await fullStats()));

app.post('/api/discover', async (c) => {
  const body: { limit?: number } = await c.req.json<{ limit?: number }>().catch(() => ({}));
  return c.json(await discover({ limit: body.limit ?? 25 }));
});

/** Схожі компанії за описом. Порожній список означає, що вектора ще немає. */
app.get('/api/companies/:id/similar', async (c) =>
  c.json(await similarCompanies(Number(c.req.param('id')))),
);

app.post('/api/embed', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
  return c.json(await embedCompanies(body.limit ?? 200));
});

app.post('/api/enrich', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number; domain?: string };
  return c.json(await enrich({ limit: body.limit ?? 25, domain: body.domain }));
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

/**
 * Drizzle загортає помилку драйвера, і назовні летить "Failed query: select ..." без причини.
 * Справжній текст лежить у cause, саме він і потрібен, коли щось не так на проді.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return causeText ? `${error.message.split('\n')[0]}: ${causeText}` : error.message;
}

app.onError((error, c) => {
  const status = (error as { status?: number }).status ?? 500;
  const message = describe(error);
  if (status !== 401) log.error({ err: message, path: c.req.path }, 'помилка API');
  return c.json({ error: message }, status as 401 | 500);
});

/*
 * Прямий запуск цього файла (`pnpm dev:api`). Драйвер бази підключається саме тут,
 * динамічним імпортом, а не зверху файла: цей самий модуль імпортує `worker.ts`
 * для Cloudflare, а туди `better-sqlite3` тягнути не можна, там база це D1.
 *
 * Без цього рядка команда піднімала сервер, але кожен роут віддавав 500
 * "база не підключена". У CLAUDE.md `dev:api` вказана як команда запуску.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  await import('../db/client.node.js');
  const port = Number(process.env.API_PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  log.info({ port }, 'API запущено');
}
