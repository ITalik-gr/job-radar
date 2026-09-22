import { Hono } from 'hono';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  snapshots,
  vacancies,
} from '../db/schema.js';
import { scoreCompany } from '../pipeline/company-score.js';
import { normalizeEmail, rememberContact } from '../pipeline/outreach.js';
import { refreshCompany } from '../pipeline/refresh.js';
import { companyVerdict } from '../pipeline/verdict.js';
import { deleteContact, updateContact } from '../pipeline/contacts.js';

export const companiesRoutes = new Hono();

/** Count open vacancies with a subquery, so they are not all loaded into memory. */
const openVacancies = sql<number>`(
  select count(*) from ${vacancies}
  where ${vacancies.companyId} = ${companies.id} and ${vacancies.closedAt} is null
)`;

companiesRoutes.get('/', async (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const country = c.req.query('country');
  const ats = c.req.query('ats');
  const search = c.req.query('q');

  const filters = [
    status ? eq(companyState.status, status) : undefined,
    country ? eq(companies.country, country) : undefined,
    ats ? eq(companies.careersKind, ats) : undefined,
    search
      ? or(like(companies.name, `%${search}%`), like(companies.domain, `%${search}%`))
      : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      country: companies.country,
      city: companies.city,
      sizeHint: companies.sizeHint,
      tags: companies.tags,
      description: companies.description,
      sourceUrl: companies.sourceUrl,
      careersKind: companies.careersKind,
      careersUrl: companies.careersUrl,
      techHints: companies.techHints,
      sources: companies.sources,
      lastChecked: companies.lastChecked,
      /*
       * The fields company scoring reads. Without them the score on this page was computed from an
       * incomplete company and did not match the same score on Studios: kind, abandoned site signs
       * and catalog reputation simply never got here.
       */
      kind: companies.kind,
      copyrightYear: companies.copyrightYear,
      lastPostAt: companies.lastPostAt,
      rating: companies.rating,
      reviewsCount: companies.reviewsCount,
      hourlyRate: companies.hourlyRate,
      minProject: companies.minProject,
      foundedYear: companies.foundedYear,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      openVacancies: openVacancies.as('open_vacancies'),
    })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(companies.name);

  // Sort by studio score rather than vacancy count: otherwise giants with hundreds of positions
  // settle at the top forever, and applying there makes no sense.
  const scored = rows.map((row) => ({
    ...row,
    score: scoreCompany({
      // The row already has every column scoring reads, so there is no need to list them again:
      // that very list is what drifted away from the schema.
      company: row as never,
      openVacancies: row.openVacancies,
      status: row.status,
    }).score,
  }));

  const sort = c.req.query('sort') ?? 'score';
  scored.sort((a, b) =>
    sort === 'vacancies'
      ? b.openVacancies - a.openVacancies
      : sort === 'name'
        ? a.name.localeCompare(b.name)
        : b.score - a.score,
  );

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
    vacancies: await db
      .select()
      .from(vacancies)
      .where(eq(vacancies.companyId, id))
      .orderBy(desc(vacancies.firstSeen)),
    contacts: await db.select().from(contacts).where(eq(contacts.companyId, id)),
    outreach: await db
      .select()
      .from(outreach)
      .where(eq(outreach.companyId, id))
      .orderBy(desc(outreach.sentAt)),
    snapshots: await db
      .select({
        id: snapshots.id,
        url: snapshots.url,
        fetchedAt: snapshots.fetchedAt,
        contentHash: snapshots.contentHash,
        blocks: sql<number>`json_array_length(${snapshots.blockHashes})`,
      })
      .from(snapshots)
      .where(eq(snapshots.companyId, id))
      .orderBy(desc(snapshots.fetchedAt)),
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
