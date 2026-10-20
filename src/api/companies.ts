import { Hono } from 'hono';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, leads, outreach, siteAudits } from '../db/schema.js';
import { scoreCompany } from '../pipeline/company-score.js';
import { hiringNow } from '../pipeline/hiring.js';
import { normalizeEmail, rememberContact } from '../pipeline/outreach.js';
import { refreshCompany } from '../pipeline/refresh.js';
import { companyVerdict } from '../pipeline/verdict.js';
import { deleteContact, updateContact } from '../pipeline/contacts.js';

export const companiesRoutes = new Hono();

companiesRoutes.get('/', async (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const country = c.req.query('country');
  const market = c.req.query('market');
  const kind = c.req.query('kind');
  const ats = c.req.query('ats');
  const search = c.req.query('q');

  const filters = [
    status ? eq(companyState.status, status) : undefined,
    country ? eq(companies.country, country) : undefined,
    market ? eq(companies.market, market) : undefined,
    kind ? eq(companies.kind, kind) : undefined,
    ats ? eq(companies.careersKind, ats) : undefined,
    search
      ? or(like(companies.name, `%${search}%`), like(companies.domain, `%${search}%`))
      : undefined,
  ].filter(Boolean);

  /*
   * The whole row, not a column list: a hand-written list is what drifted away from the schema
   * before, and the score here stopped matching the same score on Studios.
   */
  const rows = await db
    .select({ company: companies, status: companyState.status, snoozedUntil: companyState.snoozedUntil })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(companies.name);

  const now = Date.now();
  const scored = rows.map(({ company, status: state, snoozedUntil }) => {
    // The embedding is a long vector nobody reads in a table.
    const { embedding: _embedding, ...rest } = company;
    return {
      ...rest,
      status: state,
      snoozedUntil,
      hiring: hiringNow(company, now),
      score: scoreCompany({ company, status: state }).score,
    };
  });

  const sort = c.req.query('sort') ?? 'score';
  scored.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.score - a.score));

  return c.json(scored);
});

companiesRoutes.get('/:id', async (c) => {
  const db = getDb();
  const id = Number(c.req.param('id'));

  const [company] = await db.select().from(companies).where(eq(companies.id, id));
  if (!company) return c.json({ error: 'no such company' }, 404);

  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, id));

  return c.json({
    company,
    state: state ?? null,
    contacts: await db.select().from(contacts).where(eq(contacts.companyId, id)),
    outreach: await db
      .select()
      .from(outreach)
      .where(eq(outreach.companyId, id))
      .orderBy(desc(outreach.sentAt)),
    audits: await db
      .select()
      .from(siteAudits)
      .where(eq(siteAudits.companyId, id))
      .orderBy(desc(siteAudits.checkedAt))
      .limit(5),
    leads: await db.select().from(leads).where(eq(leads.companyId, id)).orderBy(desc(leads.firstSeen)),
  });
});

/**
 * A contact added by hand from the studio page.
 *
 * The email on a site often sits where the parser cannot reach: in an image, in a form, in a
 * script-rendered footer. Spotting and typing it takes a minute, and without this button the
 * company would stay forever without an address and without a letter.
 */
/**
 * A full review of one company: back to the site, stack, contacts, careers page. Nightly passes do
 * the same on schedule, while here it happens now and unconditionally.
 */
companiesRoutes.post('/:id/refresh', async (c) =>
  c.json(await refreshCompany(Number(c.req.param('id')))),
);

/**
 * The model's verdict: which template to approach this company with and what to hook onto.
 *
 * POST rather than GET on purpose: behind the button is a model call that spends the daily cap. A
 * repeated press is served from cache as long as neither the templates nor the company data
 * changed, but that cheapness is no reason to make it a GET someone might one day call in a loop.
 */
companiesRoutes.post('/:id/verdict', async (c) =>
  c.json(await companyVerdict(Number(c.req.param('id')))),
);

companiesRoutes.post('/:id/contacts', async (c) => {
  const companyId = Number(c.req.param('id'));
  const body = await c.req
    .json<{ email?: string; name?: string; role?: string }>()
    .catch(() => ({}) as { email?: string; name?: string; role?: string });

  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: 'a valid address is required' }, 400);

  const result = await rememberContact(companyId, email, body.name?.trim() || null, body.role?.trim() || null);
  return c.json({ email, ...result });
});

/**
 * Editing a found contact.
 *
 * Collection yields halves: a team page brings a name with a title and no address, a contact page
 * brings an address without a name. Only a person can join them, and without this endpoint the
 * only way was to add yet another row.
 *
 * The path sits under the company on purpose: a contact does not exist outside a company, and this
 * way the logs show right away whose contact was edited.
 */
companiesRoutes.patch('/:id/contacts/:contactId', async (c) => {
  const body = await c.req
    .json<{ name?: string | null; role?: string | null; email?: string | null; emailValid?: boolean }>()
    .catch(() => ({}));

  try {
    return c.json(await updateContact(Number(c.req.param('contactId')), body));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** Deleting a contact: collection regularly picks up an investor from a testimonial or a client from a case study. */
companiesRoutes.delete('/:id/contacts/:contactId', async (c) =>
  c.json(await deleteContact(Number(c.req.param('contactId')))),
);

companiesRoutes.post('/:id/state', async (c) => {
  const db = getDb();
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status: string; reason?: string; days?: number }>();

  const snoozedUntil = body.status === 'snoozed' ? Date.now() + (body.days ?? 30) * 86_400_000 : null;
  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, id));

  if (existing) {
    await db
      .update(companyState)
      .set({ status: body.status, reason: body.reason ?? existing.reason, snoozedUntil, updatedAt: Date.now() })
      .where(eq(companyState.companyId, id));
  } else {
    await db
      .insert(companyState)
      .values({ companyId: id, status: body.status, reason: body.reason ?? null, snoozedUntil });
  }

  return c.json({ ok: true });
});
