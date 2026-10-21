import { Hono } from 'hono';
import {
  bulkUpdateCompanies,
  companyDetail,
  COMPANY_STATUSES,
  setCompanyStatus,
  type BulkInput,
  type CompanyStatus,
} from '../pipeline/companies.js';
import { filterFromQuery } from '../pipeline/filters.js';
import { companyFacets } from '../pipeline/stats.js';
import { studioPage, type StudioFilters } from '../pipeline/studios.js';
import { normalizeEmail, rememberContact } from '../pipeline/outreach.js';
import { refreshCompany } from '../pipeline/refresh.js';
import { companyVerdict } from '../pipeline/verdict.js';
import { deleteContact, updateContact } from '../pipeline/contacts.js';

export const companiesRoutes = new Hono();

/**
 * Pagination and sorting around the shared filter. Returns the error instead of throwing, so a
 * route answers 400 with the reason: an unknown parameter must not silently widen the list.
 */
export function pageFilters(query: Record<string, string>): StudioFilters | { error: string } {
  const { limit, sort, ...rest } = query;
  try {
    return {
      ...filterFromQuery(rest),
      limit: limit ? Number(limit) : undefined,
      sort: sort === 'name' ? 'name' : 'score',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The directory: every company the filter matches, with no threshold and nothing hidden. */
companiesRoutes.get('/', async (c) => {
  const filters = pageFilters(c.req.query());
  if ('error' in filters) return c.json(filters, 400);
  return c.json(await studioPage({ ...filters, limit: filters.limit ?? Number.MAX_SAFE_INTEGER, scope: 'all' }));
});

/** The values the filter selects offer: segments, industries, sources and so on, with counts. */
companiesRoutes.get('/facets', async (c) => c.json(await companyFacets()));

companiesRoutes.post('/bulk', async (c) => {
  const body = await c.req.json<BulkInput>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) return c.json({ error: 'ids are required' }, 400);
  if (body.status && !COMPANY_STATUSES.includes(body.status)) return c.json({ error: `unknown status: ${body.status}` }, 400);
  try {
    return c.json(await bulkUpdateCompanies(body));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

companiesRoutes.get('/:id', async (c) => {
  const detail = await companyDetail(Number(c.req.param('id')));
  if (!detail) return c.json({ error: 'no such company' }, 404);
  return c.json(detail);
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
  const body = await c.req.json<{ status: CompanyStatus; reason?: string; days?: number }>();
  try {
    return c.json({ ok: true, ...(await setCompanyStatus(Number(c.req.param('id')), body)) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
