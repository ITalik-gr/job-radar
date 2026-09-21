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

// The tool is local and single-user, so there is no authentication on purpose.
const WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * While the radar lives on localhost, no authentication is needed. Once it is public, its
 * company database and correspondence are open to the world without a token, so the check
 * switches on automatically when RADAR_TOKEN is set.
 */
export function requireToken(token: string | undefined) {
  return async (c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined; path: string; method: string } }, next: () => Promise<void>) => {
    /*
     * The Google callback arrives from the browser as a redirect, a header cannot ride along.
     * Instead of the token it checks `state`, which we put into the link ourselves.
     */
    const open = ['/api/health', '/api/gmail/callback'];
    if (!token || c.req.method === 'OPTIONS' || open.includes(c.req.path)) return next();

    const provided =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.header('x-radar-token') ??
      c.req.query('token');

    if (provided !== token) {
      throw Object.assign(new Error('missing or invalid token'), { status: 401 });
    }
    return next();
  };
}

/**
 * One CORS handler for everything: the interface calls from 5173, and the catalog collector
 * runs in a third-party site's tab, so /api/import allows any origin.
 * The server listens on localhost only, these routes are not reachable from outside.
 */
app.use(
  '/api/*',
  cors({
    origin: (origin, c) =>
      c.req.path.startsWith('/api/import/') ? origin ?? '*' : WEB_ORIGINS.includes(origin) ? origin : null,
    /*
     * The list must match what the application really sends. Edits to templates, drafts,
     * facts, rules and contacts go through PATCH, PUT and DELETE, and while they were
     * missing here any call from another origin bounced at preflight. Locally this never
     * showed, because vite proxies `/api` and makes the requests same-origin, so the trap
     * waited for the first person to open the interface without the proxy.
     */
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'x-radar-token', 'authorization'],
  }),
);

app.use('/api/*', async (c, next) => requireToken(config.token)(c, next));

/**
 * Health. With `?deep=1` it also checks the database: in production the most common cause
 * of failures is unapplied migrations, and then every query dies with "no such table".
 */
/**
 * How many migrations the database already has. The bookkeeping table differs: locally it is
 * drizzle's, on Cloudflare wrangler keeps its own. Both give the same number, so we ask the one
 * that exists rather than the one we expected to see.
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
      // No such table means the other one keeps the books. Try the next.
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
     * A table being present is not enough. A migration that only adds columns leaves the list
     * of tables unchanged, so a worker with new code and an old schema looked healthy here
     * while the Companies page returned 500 "no such column: companies.rating".
     * Hence a probe on the newest columns too: a cheap query that catches exactly this case.
     */
    let columns: string | null = null;
    try {
      await getDb().all(sql`select rating, reviews_count, extra from companies limit 1`);
    } catch (error) {
      columns = describe(error);
    }

    /*
     * This is the main check here, not the column probe above.
     *
     * The probe knows only the columns someone once wrote into it, so every later migration
     * slips past it. That is exactly what happened: the database fell two migrations behind,
     * the Studios page returned 500 "no such column: needs_browser", and `deep=1` cheerfully
     * answered "ok". Comparing counts knows nothing about the schema and therefore never goes
     * stale: the journal has as many entries as there are migration files, and the database
     * must have exactly as many.
     */
    const applied = await migrationsApplied();
    const total = journal.entries.length;
    const behind = applied === null ? null : total - applied;

    const ok = missing.length === 0 && columns === null && behind === 0;

    return c.json({
      ...base,
      ok: base.ok && ok,
      db: ok ? 'ok' : 'migrations not applied',
      tables,
      missing,
      columns,
      migrations: { applied, expected: total, behind },
      hint: ok ? null : 'pnpm db:migrate locally or pnpm cf:migrate on the worker',
    });
  } catch (error) {
    return c.json({ ...base, ok: false, db: 'error', error: describe(error) }, 500);
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
 * Top up today's slice. An owner action rather than automatic: the slice is fixed on
 * purpose, otherwise a new vacancy with a higher score would push out one not yet looked at.
 */
app.post('/api/queue/top-up', async (c) => c.json(await topUpQueue()));

/**
 * CSV export straight from the interface. Served as a file, so the browser saves it at
 * once instead of showing it as text.
 */
app.get('/api/export/:what', async (c) => {
  const what = c.req.param('what');
  const named = c.req.query('named') === '1';

  let rows: Record<string, unknown>[] = [];

  if (what === 'queue') {
    rows = (await getQueue(todayKey())).map((card) => ({
      company: card.company,
      domain: card.domain,
      vacancy: card.title,
      score: card.score,
      seniority: card.seniority,
      location: card.location,
      salary: [card.salaryMin, card.salaryMax].filter(Boolean).join(' - '),
      stack: card.stack.join(' '),
      url: card.url,
      decision: card.decision ?? '',
    }));
  } else if (what === 'studios') {
    const page = await studioPage({ limit: 1000, withNamedContact: named });
    rows = page.cards.map((card) => ({
      company: card.name,
      domain: card.domain,
      kind: card.kind,
      score: card.score,
      location: [card.city, card.country].filter(Boolean).join(', '),
      contact: card.contacts.find((contact) => contact.name)?.name ?? '',
      role: card.contacts.find((contact) => contact.name)?.role ?? '',
      email:
        card.contacts.find((contact) => contact.name && contact.email)?.email ??
        card.contacts.find((contact) => contact.email)?.email ??
        '',
      vacancies: card.openVacancies,
      rating: card.rating ?? '',
      reviews: card.reviewsCount ?? '',
      hourly_rate: card.hourlyRate ?? '',
      min_project: card.minProject ?? '',
    }));
  } else {
    return c.json({ error: `unknown export type: ${what}` }, 400);
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
    return c.json({ error: `unknown action: ${body.action}` }, 400);
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
    'catalog page received from the browser',
  );
  return c.json(result);
});

app.get('/api/studios', async (c) => {
  // The limit is deliberately high: the studio list is the owner's main working tool, and
  // 25 records out of 300 companies in the database looked as if collection was broken.
  // The whole response weighs about 300 KB, which is nothing for a local tool.
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
 * Selection rules and letter templates are edited from the interface, not only from a file.
 * Workers has no filesystem, so without these routes production could change neither the
 * threshold, nor the stop words, nor the letter text, except by a new deploy.
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
 * Small one-click edits: spot a tag in a vacancy and send it straight to the stop words or
 * give it a weight. The full rules object does not travel back and forth for this.
 */
app.post('/api/rules/stop-words', async (c) => {
  const { word, remove } = (await c.req.json()) as { word?: string; remove?: boolean };
  const value = word?.trim().toLowerCase();
  if (!value) return c.json({ error: 'a word is required' }, 400);

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
  if (!value) return c.json({ error: 'a term is required' }, 400);

  const current = rules();
  const terms = { ...current.weights.terms };
  if (weight === null || weight === undefined) delete terms[value];
  else terms[value] = weight;

  const saved = await saveRules({ ...current, weights: { ...current.weights, terms } });
  return c.json({ rules: saved, source: rulesSource() });
});

/**
 * Connecting mail straight from production: OAuth starts here and comes back here.
 *
 * Why, when there is `pnpm cli auth:gmail`: the local path requires running the project on
 * a laptop, while the radar lives on Workers. One browser, two pages, and no local process.
 */
app.get('/api/gmail/connect', (c) => {
  if (!gmailConfigured()) {
    return c.json({ error: 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GMAIL_FROM_EMAIL first' }, 400);
  }
  // state carries the radar token: the callback itself arrives from the browser without headers.
  return c.redirect(authUrl(config.token));
});

/*
 * The Google callback. A token in a header is impossible here, so the check goes through
 * `state`, which we put into the link ourselves and which Google returns unchanged.
 */
app.get('/api/gmail/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  if (config.token && state !== config.token) return c.text('invalid state', 401);
  if (!code) return c.text(`Google returned an error: ${c.req.query('error') ?? 'no code'}`, 400);

  const token = await exchangeCode(code);

  /*
   * The refresh token is shown exactly once and is not stored anywhere.
   *
   * A worker secret cannot be rewritten from outside, and putting it into the database is
   * forbidden: a database backup with the token inside is mailbox access in every archive.
   * So the owner copies it into `wrangler secret put` by hand, and that is how it should be.
   */
  return c.html(
    `<meta charset="utf-8"><body style="font:15px system-ui;padding:32px;max-width:760px">
      <h2>Gmail connected: ${token.email ?? 'unknown account'}</h2>
      <p>Copy the refresh token and store it as a worker secret:</p>
      <pre style="background:#f4f4f5;padding:12px;white-space:pre-wrap;word-break:break-all">npx wrangler secret put GMAIL_REFRESH_TOKEN
${token.refreshToken}</pre>
      <p>This token is not saved anywhere else and will not be shown again.
      Once the secret is added, the worker will send letters on its own.</p>
    </body>`,
  );
});

/** Mail connection status. A separate route rather than a field in /api/stats: the sending
 * page must always show it, and a silent "letters are not going out" is worse here than
 * any error.
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
   * The starter set is no longer topped up automatically when the page opens. It used to be,
   * and deleted templates kept coming back: the owner cleaned the list, reloaded the tab and
   * saw them again. Now it is a separate action on the Operations page.
   */
  return c.json({ kinds: TEMPLATE_KINDS, templates: await listTemplates(c.req.query('kind')) });
});

app.post('/api/templates', async (c) => {
  const body = (await c.req.json()) as { name?: string };
  if (!body.name?.trim()) return c.json({ error: 'a name is required' }, 400);
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
 * DELETE erases for good. It used to archive, and that was a trap: the button said "delete"
 * while the record stayed in the database. Archiving is now its own action, as it reads.
 */
app.delete('/api/templates/:id', async (c) => c.json(await deleteTemplate(Number(c.req.param('id')))));

app.route('/api/companies', companiesRoutes);

/*
 * Sending. Drafts live in the same table as the history, so the routes use their own prefix:
 * /api/outreach returns what was sent, /api/outreach/drafts what is ready to send.
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

/** A draft for one company: the button on Queue and Studios. */
app.post('/api/outreach/drafts', async (c) => {
  const body = await c.req.json<{
    companyId: number;
    vacancyId?: number | null;
    ai?: boolean;
    /** Template picked by hand on the card. Empty means choosing by role and language. */
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
    /** An address typed by hand. It also becomes a company contact. */
    contactEmail?: string | null;
    contactName?: string | null;
  }>();
  return c.json(await updateDraft(Number(c.req.param('id')), body));
});

app.delete('/api/outreach/drafts/:id', async (c) =>
  c.json(await discardDraft(Number(c.req.param('id')))),
);

/**
 * A different template for a draft. The text is rebuilt from the same company data, and the
 * already written first paragraph carries over: no model call here.
 */
app.post('/api/outreach/drafts/:id/template', async (c) => {
  const body = await c.req.json<{ slug?: string }>().catch(() => ({}) as { slug?: string });
  if (!body.slug) return c.json({ error: 'a template key is required' }, 400);
  return c.json(await retemplateDraft(Number(c.req.param('id')), body.slug));
});

/** Regenerate the first paragraph. Only on a button press, there are no background regenerations. */
app.post('/api/outreach/drafts/:id/regenerate', async (c) =>
  c.json(await regenerateIntro(Number(c.req.param('id')))),
);

app.post('/api/outreach/followups', async (c) => c.json(await prepareFollowups()));

app.get('/api/stats/outreach', async (c) => c.json(await outreachStats()));

/*
 * Operations that used to live only in the CLI. The routes share one shape on purpose:
 * POST, a body with an optional limit, and the same response the command used to print.
 * That way the interface knows nothing about each operation and draws them as a list.
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

/** The starter template set. Only on a button press: deleted ones do not come back by themselves. */
app.post('/api/templates/seed', async (c) => c.json({ added: await seedTemplates() }));

/** A live model call: checks the key, the gateway and the provider in one go. */
app.post('/api/llm/ping', async (c) => {
  try {
    const raw = await callModelWith('Reply with one word.', 'say ok');
    return c.json({
      ok: true,
      provider: config.llm.provider,
      model: config.llm.activeModel,
      gateway: config.llm.baseUrl || 'direct call',
      answer: raw.text.trim().slice(0, 40),
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, gateway: config.llm.baseUrl || 'direct call', error: message });
  }
});

/**
 * A test letter to yourself. The subject carries non-ASCII text on purpose, including a
 * Cyrillic word: that is where header encoding breaks.
 */
app.post('/api/gmail/test', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { to?: string };
  const to = body.to || config.gmail.fromEmail;
  if (!to) return c.json({ error: 'no address: set GMAIL_FROM_EMAIL' }, 400);

  const result = await deliver({
    to,
    subject: 'Job Radar: encoding check, тест, café',
    body: [
      'This is a technical letter from Job Radar.',
      '',
      'If the subject and this line read without garbled characters, the encoding is right.',
      '',
      '',
    ].join('\n'),
  });
  return c.json({ to, ...result });
});

const NOTIFY_KINDS = ['digest', 'outreach', 'highScore', 'followUps', 'broken'] as const;


app.post('/api/notify/:kind', async (c) => {
  const kind = c.req.param('kind') as (typeof NOTIFY_KINDS)[number];
  if (!NOTIFY_KINDS.includes(kind)) return c.json({ error: `unknown notification: ${kind}` }, 400);
  // An empty message is not an error: the queue simply has nothing to show.
  return c.json({ kind, sent: await notify[kind]() });
});

/** The signature shared by all letters. Edited on the Templates page. */
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

/** A check without sending: the interface shows the reasons before the button is pressed. */
app.get('/api/outreach/drafts/:id/check', async (c) =>
  c.json({ blockers: await checkSend(Number(c.req.param('id'))) }),
);

/*
 * Sending exactly one letter on an explicit press. There is no bulk action on purpose,
 * section 0 of OUTREACH.md: autopilot from a personal Gmail gets the account blocked, and a
 * "send all" button is autopilot under another name.
 */
app.post('/api/outreach/drafts/:id/send', async (c) => {
  /*
   * A blocked letter is not a request error but a normal state with a list of reasons, hence
   * 200 and `sent: false`. A 4xx code would swallow the list itself: the client would see
   * "409" and no explanation of what is in the way.
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
    return c.json({ error: `unknown reply type: ${body.replyType}` }, 400);
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

/** Getro networks in order: the Operations page goes through them one at a time. */
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
   * Getro goes through networks one at a time, because the worker cannot finish all twelve
   * in one request. The cursor comes back in the response, and the Operations page calls the
   * next one with it. Without this field the pass would look finished after the first network.
   */
  if (id === 'getro') {
    // Without an explicit network this is a pass over all of them, as in cron and the CLI, with nothing to continue.
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
    // Shows who classifies: Anthropic billing per token or the Workers AI quota.
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

/** Similar companies by description. An empty list means there is no vector yet. */
app.get('/api/companies/:id/similar', async (c) =>
  c.json(await similarCompanies(Number(c.req.param('id')))),
);

app.post('/api/embed', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
  return c.json(await embedCompanies(body.limit ?? 200));
});

/*
 * The queue for the extension, and receiving what it read.
 *
 * Sites rendered by script cannot be read by the server-side crawl: the HTML is an empty
 * shell. The extension opens them in the owner's own browser in a background tab, takes the
 * email and stack from the finished DOM and sends them here. CORS for /api/import/* is
 * already open, so receiving lives under exactly this prefix.
 */
app.get('/api/import/browser/queue', async (c) =>
  c.json({ targets: await browserQueue(Number(c.req.query('limit') ?? 20)) }),
);

app.post('/api/import/browser/site', async (c) => {
  const body = await c.req.json<BrowserFindings>();
  if (!body?.domain) return c.json({ error: 'a domain is required' }, 400);
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
 * Telegram webhook for the deployed version. Enabled once:
 * https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/api/telegram/webhook
 */
app.post('/api/telegram/webhook', async (c) => {
  const { webhookCallback } = await import('grammy');
  const { buildBot, isConfigured: telegramReady } = await import('../notify/telegram.js');
  if (!telegramReady()) return c.json({ error: 'telegram is not configured' }, 400);
  return webhookCallback(buildBot(), 'hono')(c);
});

app.get('/api/vacancies/:id', async (c) => {
  const db = getDb();
  const [row] = await db.select().from(vacancies).where(eq(vacancies.id, Number(c.req.param('id'))));
  return row ? c.json(row) : c.json({ error: 'no such vacancy' }, 404);
});

/**
 * Drizzle wraps the driver error, and "Failed query: select ..." leaks out with no cause.
 * The real text sits in cause, and that is what is needed when something breaks in production.
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
  if (status !== 401) log.error({ err: message, path: c.req.path }, 'API error');
  return c.json({ error: message }, status as 401 | 500);
});

/*
 * Running this file directly (`pnpm dev:api`). The database driver is attached here, through
 * a dynamic import rather than at the top of the file: this same module is imported by
 * `worker.ts` for Cloudflare, and `better-sqlite3` must not be pulled in there, the database is D1.
 *
 * Without this line the command started the server, but every route returned 500
 * "database not connected". CLAUDE.md lists `dev:api` as the start command.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  await import('../db/client.node.js');
  // Same with the Gmail token: file storage exists only in Node, not in the worker.
  await import('../lib/gmail-store.node.js');
  const port = Number(process.env.API_PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  log.info({ port }, 'API started');
}
