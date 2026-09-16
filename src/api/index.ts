import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import journal from '../db/migrations/meta/_journal.json' with { type: 'json' };
import { desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { runs, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { authUrl, exchangeCode, gmailStatus, isConfigured as gmailConfigured } from '../lib/gmail.js';
import { deliver, mailer, mailerStatuses } from '../lib/mailer.js';
import {
  draftForCompany,
  discardDraft,
  listDrafts,
  prepareDrafts,
  retemplateDraft,
  readSignature,
  saveSignature,
  rememberContact,
  normalizeEmail,
  regenerateIntro,
  updateDraft,
} from '../pipeline/outreach.js';
import { checkSend, sendCounters } from '../pipeline/send-guards.js';
import { checkReplies } from '../pipeline/replies.js';
import { notify } from '../notify/telegram.js';

import { classifyPending } from '../pipeline/reclassify.js';
import { refreshDetails } from '../pipeline/sync.js';
import { backfillKinds } from '../pipeline/company-kind.js';
import { backfillCatalogFields } from '../pipeline/backfill-catalog.js';
import { callModelWith } from '../pipeline/classify.js';
import { seedOutreachTemplates } from '../pipeline/outreach.js';
import { seedTemplates } from '../pipeline/templates.js';
import { GETRO_NETWORKS, nextGetroNetwork } from '../sources/boards/getro.js';
import { createFact, deleteFact, listFacts, updateFact } from '../pipeline/facts.js';
import { prepareFollowups } from '../pipeline/followups.js';
import { outreachStats } from '../pipeline/outreach-stats.js';
import { sendDraft } from '../pipeline/send.js';
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
import { browserQueue, enrich, saveBrowserFindings, type BrowserFindings } from '../pipeline/enrich.js';
import { syncCatalog, syncDou, importFromBrowser } from '../pipeline/catalogs.js';
import { companiesRoutes } from './companies.js';
import { applyStudioAction, studioPage, type StudioActionInput } from '../pipeline/studios.js';
import { recalcScores } from '../pipeline/recalc.js';
import { resetRules, rules, rulesSource, saveRules } from '../pipeline/rules.js';
import {
  TEMPLATE_KINDS,
  archiveTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  restoreTemplate,
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
    /*
     * Колбек Google приходить із браузера редіректом, заголовок туди не покласти.
     * Замість токена він перевіряє `state`, який ми самі поклали в посилання.
     */
    const open = ['/api/health', '/api/gmail/callback'];
    if (!token || c.req.method === 'OPTIONS' || open.includes(c.req.path)) return next();

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
    /*
     * Перелік мусить збігатися з тим, що застосунок реально шле. Правки шаблонів,
     * чернеток, фактів, правил і контактів ідуть через PATCH, PUT і DELETE, і
     * поки їх тут не було, будь-яке звернення не з того самого походження
     * відбивалось ще на preflight. Локально це не виявлялось, бо vite проксює
     * `/api` і робить запити своїми, тобто пастка чекала на першого, хто
     * відкриє інтерфейс не через проксі.
     */
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'x-radar-token', 'authorization'],
  }),
);

app.use('/api/*', async (c, next) => requireToken(config.token)(c, next));

/**
 * Здоровʼя. З `?deep=1` ще й перевіряє базу: на проді найчастіша причина падінь це
 * незастосовані міграції, і тоді будь-який запит валиться з "no such table".
 */
/**
 * Скільки міграцій уже лягло в базу. Таблиця обліку різна: локально це drizzle,
 * на Cloudflare wrangler веде свою. Обидві дають те саме число, тому питаємо ту,
 * яка є, а не ту, яку очікували побачити.
 */
async function migrationsApplied(): Promise<number | null> {
  for (const table of ['__drizzle_migrations', 'd1_migrations']) {
    try {
      const rows = await getDb().all<{ count: number }>(
        sql.raw(`select count(*) as count from ${table}`),
      );
      const count = rows[0]?.count;
      if (typeof count === 'number') return count;
    } catch {
      // Немає такої таблиці означає, що облік веде інша. Перевіряємо наступну.
    }
  }
  return null;
}

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

    /*
     * Наявності таблиці мало. Міграція, що лише додає колонки, лишає перелік таблиць
     * незмінним, тому воркер з новим кодом і старою схемою виглядав тут здоровим,
     * а на сторінці Компанії віддавав 500 "no such column: companies.rating".
     * Тому ще й проба на найновіші колонки: дешевий запит, який ловить саме цей випадок.
     */
    let columns: string | null = null;
    try {
      await getDb().all(sql`select rating, reviews_count, extra from companies limit 1`);
    } catch (error) {
      columns = describe(error);
    }

    /*
     * Головна перевірка тут саме ця, а не проба колонок вище.
     *
     * Проба знає лише ті колонки, які їй колись вписали, тому кожна наступна
     * міграція проходить повз неї. Саме так і сталось: база відстала на дві
     * міграції, сторінка Студії віддавала 500 "no such column: needs_browser",
     * а `deep=1` бадьоро відповідав "ok". Порівняння кількостей не знає нічого
     * про схему і тому не застаріває: у журналі стільки записів, скільки файлів
     * міграцій, і в базі має бути рівно стільки ж.
     */
    const applied = await migrationsApplied();
    const total = journal.entries.length;
    const behind = applied === null ? null : total - applied;

    const ok = missing.length === 0 && columns === null && behind === 0;

    return c.json({
      ...base,
      ok: base.ok && ok,
      db: ok ? 'ok' : 'міграції не застосовані',
      tables,
      missing,
      columns,
      migrations: { applied, expected: total, behind },
      hint: ok ? null : 'pnpm db:migrate локально або pnpm cf:migrate на воркері',
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

/**
 * Підключення пошти прямо з прода: OAuth починається тут і сюди ж повертається.
 *
 * Навіщо, якщо є `pnpm cli auth:gmail`: локальний шлях вимагає запустити проєкт
 * на ноутбуці, а радар живе на Workers. Один браузер, дві сторінки, і жодного
 * локального процесу.
 */
app.get('/api/gmail/connect', (c) => {
  if (!gmailConfigured()) {
    return c.json({ error: 'спершу GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET і GMAIL_FROM_EMAIL' }, 400);
  }
  // state несе токен радара: сам колбек приходить із браузера без заголовків.
  return c.redirect(authUrl(config.token));
});

/*
 * Колбек Google. Токен у заголовку тут неможливий, тому перевірка йде через
 * `state`, який ми самі поклали в посилання і який Google повертає незмінним.
 */
app.get('/api/gmail/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  if (config.token && state !== config.token) return c.text('невірний state', 401);
  if (!code) return c.text(`Google повернув помилку: ${c.req.query('error') ?? 'без коду'}`, 400);

  const token = await exchangeCode(code);

  /*
   * Рефреш-токен показується рівно один раз і нікуди не записується.
   *
   * Секрет воркера ззовні не переписати, а класти його в базу заборонено:
   * бекап бази з токеном усередині це доступ до пошти в кожному архіві.
   * Тому власник копіює його в `wrangler secret put` руками, і це правильно.
   */
  return c.html(
    `<meta charset="utf-8"><body style="font:15px system-ui;padding:32px;max-width:760px">
      <h2>Gmail підключено: ${token.email ?? 'акаунт невідомий'}</h2>
      <p>Скопіювати рефреш-токен і покласти його секретом воркера:</p>
      <pre style="background:#f4f4f5;padding:12px;white-space:pre-wrap;word-break:break-all">npx wrangler secret put GMAIL_REFRESH_TOKEN
${token.refreshToken}</pre>
      <p>Цей токен більше ніде не збережений і не показується вдруге.
      Після додавання секрету воркер надсилатиме листи сам.</p>
    </body>`,
  );
});

/** Стан підключення пошти. Окремим роутом, а не полем у /api/stats: сторінка
 * розсилки має показувати його завжди, і мовчазне "листи не йдуть" тут гірше
 * за будь-яку помилку.
 */
/*
 * Status of the mailbox connection, plus which provider is actually in use.
 *
 * The provider block matters because of one silent failure: switching to an API
 * sender turns reply detection off, since there is no mailbox to read. Nothing
 * errors, letters keep going out, and the Contacts page simply says nobody
 * answered. So the answer carries `readsReplies` and the interface shows it.
 */
app.get('/api/gmail/status', (c) => {
  const active = mailer();
  return c.json({
    ...gmailStatus(),
    provider: active.id,
    readsReplies: active.readsReplies,
    providers: mailerStatuses(),
  });
});

app.get('/api/templates', async (c) => {
  /*
   * Стартовий набір більше не доливається сам при відкритті сторінки. Раніше
   * доливався, і видалені шаблони поверталися: власник чистив список, оновлював
   * вкладку і бачив їх знову. Тепер це окрема дія на сторінці Операції.
   */
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

app.post('/api/templates/:id/archive', async (c) =>
  c.json(await archiveTemplate(Number(c.req.param('id')))),
);

app.post('/api/templates/:id/restore', async (c) =>
  c.json(await restoreTemplate(Number(c.req.param('id')))),
);

app.post('/api/templates/:id/duplicate', async (c) =>
  c.json(await duplicateTemplate(Number(c.req.param('id')))),
);

/*
 * DELETE стирає назовсім. Раніше він архівував, і це була пастка: кнопка називалась
 * "видалити", а запис лишався в базі. Архів тепер окремою дією, як воно й читається.
 */
app.delete('/api/templates/:id', async (c) => c.json(await deleteTemplate(Number(c.req.param('id')))));

app.route('/api/companies', companiesRoutes);

/*
 * Розсилка. Чернетки лежать у тій же таблиці, що й історія, тому роути окремим
 * префіксом: /api/outreach віддає надіслане, /api/outreach/drafts готове до відправки.
 */
app.get('/api/outreach/drafts', async (c) =>
  c.json({ drafts: await listDrafts(), counters: await sendCounters() }),
);

app.post('/api/outreach/prepare', async (c) => {
  const body = await c.req
    .json<{ limit?: number; ai?: boolean }>()
    .catch(() => ({}) as { limit?: number; ai?: boolean });
  return c.json(await prepareDrafts({ limit: body.limit, ai: body.ai }));
});

/** Чернетка для однієї компанії: кнопка з Черги і зі Студій. */
app.post('/api/outreach/drafts', async (c) => {
  const body = await c.req.json<{
    companyId: number;
    vacancyId?: number | null;
    ai?: boolean;
    /** Шаблон, вибраний руками на картці. Порожнє означає підбір за роллю і мовою. */
    templateSlug?: string | null;
  }>();

  return c.json(
    await draftForCompany(body.companyId, body.vacancyId ?? null, {
      ai: body.ai,
      templateSlug: body.templateSlug ?? null,
    }),
  );
});

app.patch('/api/outreach/drafts/:id', async (c) => {
  const body = await c.req.json<{
    subject?: string;
    body?: string;
    /** Адреса, вписана руками. Вона ж заводиться контактом компанії. */
    contactEmail?: string | null;
    contactName?: string | null;
  }>();
  return c.json(await updateDraft(Number(c.req.param('id')), body));
});

app.delete('/api/outreach/drafts/:id', async (c) =>
  c.json(await discardDraft(Number(c.req.param('id')))),
);

/**
 * Інший шаблон для чернетки. Текст збирається заново з тими самими даними компанії,
 * а вже написаний перший абзац переноситься: модель тут не викликається.
 */
app.post('/api/outreach/drafts/:id/template', async (c) => {
  const body = await c.req.json<{ slug?: string }>().catch(() => ({}) as { slug?: string });
  if (!body.slug) return c.json({ error: 'потрібен ключ шаблона' }, 400);
  return c.json(await retemplateDraft(Number(c.req.param('id')), body.slug));
});

/** Перегенерація першого абзацу. Тільки по кнопці, фонових перегенерацій немає. */
app.post('/api/outreach/drafts/:id/regenerate', async (c) =>
  c.json(await regenerateIntro(Number(c.req.param('id')))),
);

app.post('/api/outreach/followups', async (c) => c.json(await prepareFollowups()));

app.get('/api/stats/outreach', async (c) => c.json(await outreachStats()));

/*
 * Операції, які раніше жили тільки в CLI. Роути навмисно однакової форми:
 * POST, тіло з необовʼязковим limit, у відповіді те саме, що друкувала команда.
 * Інтерфейс через це не знає нічого про кожну окрему операцію і малює їх списком.
 */
app.post('/api/catalogs/:id/run', async (c) => c.json(await syncCatalog(c.req.param('id'))));

app.post('/api/classify/pending', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
  return c.json(await classifyPending(body.limit ?? 50));
});

app.post('/api/maintenance/kinds', async (c) => c.json(await backfillKinds()));

app.post('/api/maintenance/backfill-catalog', async (c) => c.json(await backfillCatalogFields()));

app.post('/api/maintenance/fix-detail', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number; source?: string };
  return c.json(await refreshDetails({ limit: body.limit ?? 25, source: body.source }));
});

app.post('/api/outreach/replies', async (c) =>
  c.json(await checkReplies({ ownEmail: config.gmail.fromEmail })),
);

app.post('/api/outreach/seed', async (c) => c.json({ added: await seedOutreachTemplates() }));

/** Стартовий набір шаблонів. Тільки по кнопці: видалене більше не воскресає само. */
app.post('/api/templates/seed', async (c) => c.json({ added: await seedTemplates() }));

/** Живий виклик моделі: перевірка ключа, шлюзу і провайдера одним рухом. */
app.post('/api/llm/ping', async (c) => {
  try {
    const raw = await callModelWith('Відповідай одним словом.', 'скажи ok');
    return c.json({
      ok: true,
      provider: config.llm.provider,
      model: config.llm.activeModel,
      gateway: config.llm.baseUrl || 'прямий виклик',
      answer: raw.text.trim().slice(0, 40),
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, gateway: config.llm.baseUrl || 'прямий виклик', error: message });
  }
});

/** Тестовий лист собі. Кирилиця в темі навмисно, на ній ламається кодування. */
app.post('/api/gmail/test', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { to?: string };
  const to = body.to || config.gmail.fromEmail;
  if (!to) return c.json({ error: 'немає адреси: заповнити GMAIL_FROM_EMAIL' }, 400);

  const result = await deliver({
    to,
    subject: 'Job Radar: перевірка кодування, тест',
    body: [
      'Це технічний лист від Job Radar.',
      '',
      'Якщо тема і цей рядок читаються без кракозябр, кодування правильне.',
      '',
      '',
    ].join('\n'),
  });
  return c.json({ to, ...result });
});

const NOTIFY_KINDS = ['digest', 'outreach', 'highScore', 'followUps', 'broken'] as const;


app.post('/api/notify/:kind', async (c) => {
  const kind = c.req.param('kind') as (typeof NOTIFY_KINDS)[number];
  if (!NOTIFY_KINDS.includes(kind)) return c.json({ error: `невідоме сповіщення: ${kind}` }, 400);
  // Порожнє повідомлення це не помилка: у черзі просто нема чого показувати.
  return c.json({ kind, sent: await notify[kind]() });
});

/** Підпис, спільний для всіх листів. Правиться на сторінці Шаблони. */
app.get('/api/outreach/signature', async (c) => c.json({ signature: await readSignature() }));

app.put('/api/outreach/signature', async (c) => {
  const body = await c.req.json<{ signature?: string }>().catch(() => ({}) as { signature?: string });
  return c.json({ signature: await saveSignature(body.signature ?? '') });
});

app.get('/api/facts', async (c) => c.json(await listFacts()));

app.post('/api/facts', async (c) => c.json(await createFact(await c.req.json())));

app.patch('/api/facts/:id', async (c) =>
  c.json(await updateFact(Number(c.req.param('id')), await c.req.json())),
);

app.delete('/api/facts/:id', async (c) => c.json(await deleteFact(Number(c.req.param('id')))));

/** Перевірка без відправки: інтерфейс показує причини ще до натискання. */
app.get('/api/outreach/drafts/:id/check', async (c) =>
  c.json({ blockers: await checkSend(Number(c.req.param('id'))) }),
);

/*
 * Відправка рівно одного листа по явному натисканню. Масової дії тут немає
 * навмисно, розділ 0 OUTREACH.md: автопілот з особистого Gmail це блокування
 * акаунта, а кнопка "надіслати всі" це автопілот з іншою назвою.
 */
app.post('/api/outreach/drafts/:id/send', async (c) => {
  /*
   * Заблокований лист це не помилка запиту, а нормальний стан з переліком
   * причин, тому 200 і `sent: false`. Код 4xx тут з'їдав би сам перелік:
   * клієнт бачив би "409" і жодного пояснення, що саме заважає.
   */
  return c.json(await sendDraft(Number(c.req.param('id'))));
});

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

/** Мережі Getro по порядку: сторінка Операції проходить їх по одній. */
app.get('/api/sources/getro/networks', (c) =>
  c.json({ networks: GETRO_NETWORKS.map((network) => network.id) }),
);

app.post('/api/sources/:id/run', async (c) => {
  const id = c.req.param('id');
  const body: { limit?: number; skipLlm?: boolean; slug?: string } = await c.req
    .json<{ limit?: number; skipLlm?: boolean; slug?: string }>()
    .catch(() => ({}));

  const result = await syncSource(id, { limit: body.limit, skipLlm: body.skipLlm, slug: body.slug });

  /*
   * Getro ходить по мережах поодинці, бо всі дванадцять за один запит воркер не
   * встигає. Курсор віддається у відповіді, і сторінка Операції за ним викликає
   * наступну. Без цього поля прохід виглядав би завершеним після першої ж мережі.
   */
  if (id === 'getro') {
    // Без явної мережі це прохід по всіх, як у крона і CLI, і продовжувати нічого.
    return c.json({ ...result, slug: body.slug ?? null, next: body.slug ? nextGetroNetwork(body.slug) : null });
  }

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

/*
 * Черга для розширення і приймання того, що воно прочитало.
 *
 * Сайти, намальовані скриптом, серверний обхід читати не вміє: у HTML там порожній
 * каркас. Розширення відкриває їх у власному браузері власника фоновою вкладкою,
 * бере з готового DOM пошту і стек і присилає сюди. CORS для /api/import/* уже
 * відкритий, тому приймання живе саме під цим префіксом.
 */
app.get('/api/import/browser/queue', async (c) =>
  c.json({ targets: await browserQueue(Number(c.req.query('limit') ?? 20)) }),
);

app.post('/api/import/browser/site', async (c) => {
  const body = await c.req.json<BrowserFindings>();
  if (!body?.domain) return c.json({ error: 'потрібен домен' }, 400);
  return c.json(await saveBrowserFindings(body));
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
  // Те саме і з токеном Gmail: файлове сховище є тільки в Node, у воркері його немає.
  await import('../lib/gmail-store.node.js');
  const port = Number(process.env.API_PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  log.info({ port }, 'API запущено');
}
