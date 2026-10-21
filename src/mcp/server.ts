import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { z } from 'zod';
import { remainingBudget } from '../lib/llm.js';
import { followUps, funnel, listOutreach } from '../pipeline/actions.js';
import {
  addCompanyNote,
  companyDetail,
  COMPANY_STATUSES,
  setCompanyStatus,
} from '../pipeline/companies.js';
import { outreachStats } from '../pipeline/outreach-stats.js';
import {
  draftForCompany,
  listDrafts,
  normalizeEmail,
  previewLetter,
  readSignature,
  rememberContact,
  saveSignature,
} from '../pipeline/outreach.js';
import { rules, rulesSource, saveRules } from '../pipeline/rules.js';
import { sendCounters } from '../pipeline/send-guards.js';
import { studioPage, type StudioCard } from '../pipeline/studios.js';
import { dailyQueue } from '../pipeline/daily-queue.js';
import { companyFilterSchema, parseFilter } from '../pipeline/filters.js';
import { findSavedFilter, listSavedFilters, saveFilter } from '../pipeline/saved-filters.js';
import { runSource } from '../pipeline/sync.js';
import { LEAD_STATUSES, listLeads, setLeadStatus } from '../pipeline/leads.js';
import { createTemplate, listTemplates, updateTemplate, type TemplateInput } from '../pipeline/templates.js';
import { getSource, listSources } from '../sources/registry.js';
import '../sources/index.js';

/**
 * The MCP server, section 8 of CLAUDE.md. Every tool calls the same pipeline function the HTTP
 * API calls, there is no second implementation to drift. Write tools return what changed.
 *
 * There is no send tool, and there must never be one: every letter leaves by a human click in
 * the web app, rule 10.
 */

const INSTRUCTIONS = `Lead Radar: the owner's private database of companies worth offering development services to.
Companies are leads; each has a status, contacts, site audits, open leads (tenders) and a letter history.
Letters come from the owner's own templates. Never write or rewrite letter text yourself: create_draft
and preview_letter fill a template, upsert_template stores text the owner gave you verbatim.
There is no way to send a letter from here: the owner sends every letter by hand in the web app.`;

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** A card trimmed for chat: the full one carries the description and catalog extras, which a list does not need. */
function compactCard(card: StudioCard) {
  const contact = card.contacts.find((row) => row.name && row.email) ?? card.contacts.find((row) => row.email) ?? null;
  return {
    id: card.companyId,
    name: card.name,
    domain: card.domain,
    kind: card.kind,
    market: card.market,
    country: card.country,
    city: card.city,
    industry: card.industry,
    status: card.status,
    score: card.score,
    why: card.why.slice(0, 4).map((row) => `${row.weight > 0 ? '+' : ''}${row.weight} ${row.reason}`),
    contact: contact ? { name: contact.name, role: contact.role, email: contact.email } : null,
    contacts: card.contacts.length,
    hiring: card.hiring,
    issues: card.audit?.issues ?? [],
    rating: card.rating,
    lastContactedAt: card.lastContactedAt,
  };
}

/** Field by field, only what differs. Enough for templates, which are flat. */
function changedFields<T extends object>(before: T, after: T, keys: string[]) {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diff[key] = { before: a[key], after: b[key] };
  }
  return diff;
}

/** Nested objects merge, everything else replaces. Arrays replace too: a partial list is a new list. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = deepMerge(base[key], value);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Leaf paths whose value changed, "companies.threshold: 40 -> 45". */
function changedPaths(before: unknown, after: unknown, prefix = ''): { path: string; before: unknown; after: unknown }[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: prefix, before, after }];
}

const TEMPLATE_FIELDS = ['slug', 'name', 'kind', 'forKind', 'targetType', 'language', 'subject', 'body', 'note', 'archived'];

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'lead-radar', version: '0.1.0' },
    {
      instructions: INSTRUCTIONS,
      // The default validator compiles schemas with `new Function`, which Workers forbid.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // Reads.

  server.registerTool(
    'search_companies',
    {
      description:
        'Companies matching a filter, best score first. `scope: "leads"` (default) is the working list: the score ' +
        'threshold applies, product companies are left out unless `kind` names them, contacted, replied, rejected ' +
        'and blacklisted ones are hidden unless `status` or `includeContacted` asks for them, active snoozes are ' +
        'hidden. `scope: "all"` is the whole directory with only the filter applied. `savedFilter` starts from a ' +
        'saved filter by name; fields given here override it.',
      inputSchema: {
        ...companyFilterSchema.shape,
        savedFilter: z.string().optional().describe('Name of a saved filter, see list_saved_filters'),
        scope: z.enum(['leads', 'all']).default('leads'),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: read,
    },
    async ({ savedFilter, scope, limit, ...args }) => {
      let base = {};
      if (savedFilter) {
        const saved = await findSavedFilter(savedFilter);
        if (!saved) return fail(`no saved filter "${savedFilter}"`);
        base = saved.query;
      }
      const defined = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
      const filter = parseFilter({ ...base, ...defined });
      const page = await studioPage({ ...filter, scope, limit });
      return json({
        filter,
        total: page.total,
        matched: page.aboveThreshold,
        threshold: page.threshold,
        companies: page.cards.map(compactCard),
      });
    },
  );

  server.registerTool(
    'daily_queue',
    {
      description:
        "Today's slice: who to write to today, mixed across segments. Fixed for the day; `done` marks a company " +
        'acted on since, untouched ones roll over to the next day first.',
      inputSchema: {},
      annotations: read,
    },
    async () => {
      const queue = await dailyQueue();
      return json({ ...queue, cards: queue.cards.map((card) => ({ ...compactCard(card), done: card.done })) });
    },
  );

  server.registerTool(
    'list_saved_filters',
    {
      description: 'Named filters the owner saved, each with its query in the search_companies shape.',
      inputSchema: {},
      annotations: read,
    },
    async () => json(await listSavedFilters()),
  );

  server.registerTool(
    'get_company',
    {
      description: 'One company with its state, contacts, letter history, latest site audits and leads.',
      inputSchema: { id: z.number().int() },
      annotations: read,
    },
    async ({ id }) => {
      const detail = await companyDetail(id);
      return detail ? json(detail) : fail(`no company ${id}`);
    },
  );

  server.registerTool(
    'list_templates',
    {
      description: 'Letter templates without their body, with how many letters used each.',
      inputSchema: { includeArchived: z.boolean().default(false) },
      annotations: read,
    },
    async ({ includeArchived }) => {
      const list = await listTemplates();
      return json(
        list
          .filter((row) => includeArchived || !row.archived)
          .map(({ body: _body, intro: _intro, ...rest }) => rest),
      );
    },
  );

  server.registerTool(
    'get_template',
    {
      description: 'One template with its full subject and body. By id or slug.',
      inputSchema: { id: z.number().int().optional(), slug: z.string().optional() },
      annotations: read,
    },
    async ({ id, slug }) => {
      const found = (await listTemplates()).find((row) => (id !== undefined ? row.id === id : row.slug === slug));
      if (!found) return fail(`no template ${id ?? slug}`);
      const { intro: _intro, ...rest } = found;
      return json(rest);
    },
  );

  server.registerTool(
    'preview_letter',
    {
      description:
        'The letter a company would get from its template, without saving a draft or crawling the site. ' +
        '`error` names what would block it (empty placeholder, no address, no signature).',
      inputSchema: {
        companyId: z.number().int(),
        templateSlug: z.string().optional().describe('Overrides the automatic choice by segment, language and contact'),
      },
      annotations: read,
    },
    async ({ companyId, templateSlug }) => {
      const result = await previewLetter(companyId, templateSlug ?? null);
      return result.letter ? json(result.letter) : fail(result.reason ?? 'no letter');
    },
  );

  server.registerTool(
    'list_outreach',
    {
      description:
        'Letter history, newest first. `status`: sent (default, everything that went out), draft (waiting to be ' +
        'sent by hand), waiting (sent with no reply for `days` or more).',
      inputSchema: {
        status: z.enum(['sent', 'draft', 'waiting']).default('sent'),
        companyId: z.number().int().optional(),
        days: z.number().int().min(1).default(7).describe('Only for waiting'),
        withBody: z.boolean().default(false).describe('Include letter text'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: read,
    },
    async ({ status, companyId, days, withBody, limit }) => {
      const rows: { companyId: number; body: string | null }[] =
        status === 'draft' ? await listDrafts() : status === 'waiting' ? await followUps(days) : await listOutreach();
      return json(
        rows
          .filter((row) => companyId === undefined || row.companyId === companyId)
          .slice(0, limit)
          .map((row) => (withBody ? row : { ...row, body: undefined, companyContacts: undefined })),
      );
    },
  );

  server.registerTool(
    'get_settings',
    {
      description: 'Scoring rules (weights, threshold, niches) and the shared letter signature.',
      inputSchema: {},
      annotations: read,
    },
    async () => json({ rules: rules(), rulesSource: rulesSource(), signature: await readSignature() }),
  );

  server.registerTool(
    'stats',
    {
      description: 'Funnel by status, outreach conversion, today\'s send counters and the model budget left.',
      inputSchema: {},
      annotations: read,
    },
    async () =>
      json({
        funnel: await funnel(),
        outreach: await outreachStats(),
        sending: await sendCounters(),
        llmBudgetLeft: await remainingBudget(),
      }),
  );

  // Writes. Each returns the state before and after.

  server.registerTool(
    'set_status',
    {
      description:
        'Set a company status. "snoozed" hides it for `days` (default 30). "interesting" never downgrades a ' +
        'company already contacted or replied; `kept` in the answer says when that happened.',
      inputSchema: {
        companyId: z.number().int(),
        status: z.enum(COMPANY_STATUSES),
        reason: z.string().optional().describe('Replaces the note on the company'),
        days: z.number().int().min(1).optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ companyId, ...input }) => json(await setCompanyStatus(companyId, input)),
  );

  server.registerTool(
    'add_note',
    {
      description: 'Append a dated note to a company. The status stays as it is.',
      inputSchema: { companyId: z.number().int(), text: z.string().min(1) },
      annotations: write,
    },
    async ({ companyId, text }) => json(await addCompanyNote(companyId, text)),
  );

  server.registerTool(
    'add_contact',
    {
      description:
        'Add an email contact to a company. Only an address the owner gave or that is visible on the company site: ' +
        'never a guessed one like info@domain. An existing address is revived if it bounced and keeps its name.',
      inputSchema: {
        companyId: z.number().int(),
        email: z.string(),
        name: z.string().optional(),
        role: z.string().optional(),
      },
      annotations: write,
    },
    async ({ companyId, email, name, role }) => {
      const address = normalizeEmail(email);
      if (!address) return fail(`not a valid address: ${email}`);
      const before = await companyDetail(companyId);
      if (!before) return fail(`no company ${companyId}`);

      const { created } = await rememberContact(companyId, address, name?.trim() || null, role?.trim() || null);
      const after = await companyDetail(companyId);
      return json({
        companyId,
        created,
        before: before.contacts.find((row) => row.email === address) ?? null,
        after: after?.contacts.find((row) => row.email === address) ?? null,
      });
    },
  );

  server.registerTool(
    'upsert_template',
    {
      description:
        'Create or edit a letter template. With `id` or the slug of an existing template it edits, otherwise it ' +
        'creates (then `name` is required). Store the owner\'s text verbatim, do not compose letters. ' +
        'Placeholders: {{company}} {{name}} {{first_name}} {{city}} {{site}} {{industry}} {{finding}} ' +
        '{{lead_title}} {{signature}}, with a fallback as {{first_name|колеги}}.',
      inputSchema: {
        id: z.number().int().optional(),
        slug: z.string().optional(),
        name: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        language: z.enum(['uk', 'en']).optional(),
        targetType: z
          .enum(['studio_named', 'studio_generic', 'followup'])
          .nullable()
          .optional()
          .describe('Sending role; null keeps the template out of automatic choice'),
        forKind: z.string().nullable().optional().describe('Segment the text is written for; null means any'),
        note: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      },
      annotations: write,
    },
    async ({ id, ...input }) => {
      const list = await listTemplates();
      const existing = list.find((row) => (id !== undefined ? row.id === id : input.slug !== undefined && row.slug === input.slug));
      if (id !== undefined && !existing) return fail(`no template ${id}`);

      if (!existing) {
        if (!input.name?.trim()) return fail('a new template needs a name');
        const created = await createTemplate(input as TemplateInput);
        if (input.archived) await updateTemplate(created.id, { archived: true });
        const { intro: _intro, ...after } = created;
        return json({ created: true, after });
      }

      const updated = await updateTemplate(existing.id, input as Partial<TemplateInput>);
      return json({
        created: false,
        id: existing.id,
        changed: changedFields(existing, updated, TEMPLATE_FIELDS),
      });
    },
  );

  server.registerTool(
    'create_draft',
    {
      description:
        'Put a draft for one company into the Sending queue, filled from a template. If the company has no address ' +
        'yet its site is crawled first. The owner reviews and sends it by hand in the web app; this never sends.',
      inputSchema: {
        companyId: z.number().int(),
        templateSlug: z.string().optional(),
      },
      annotations: { ...write, openWorldHint: true },
    },
    async ({ companyId, templateSlug }) => {
      const result = await draftForCompany(companyId, { templateSlug: templateSlug ?? null });
      if (!result.draft) return result.id ? json({ created: false, ...result }) : fail(result.reason ?? 'no draft');
      return json({ created: true, ...result });
    },
  );

  server.registerTool(
    'update_settings',
    {
      description:
        'Change scoring rules and the signature. `rules` is a partial object merged into the current rules ' +
        '(see get_settings for the shape); arrays are replaced whole. Returns every changed path.',
      inputSchema: {
        rules: z.record(z.unknown()).optional(),
        signature: z.string().optional(),
      },
      annotations: write,
    },
    async (input) => {
      const changes: { path: string; before: unknown; after: unknown }[] = [];

      if (input.rules) {
        const before = rules();
        const saved = await saveRules(deepMerge(before, input.rules));
        changes.push(...changedPaths(before, saved).map((row) => ({ ...row, path: `rules.${row.path}` })));
      }

      if (input.signature !== undefined) {
        const before = await readSignature();
        const after = await saveSignature(input.signature);
        if (before !== after) changes.push({ path: 'signature', before, after });
      }

      return json({ changes });
    },
  );

  server.registerTool(
    'save_filter',
    {
      description:
        'Save a filter under a name, in the search_companies shape (without savedFilter, scope, limit). ' +
        'An existing name is replaced; the answer shows the query before and after.',
      inputSchema: { name: z.string().min(1), filter: companyFilterSchema },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ name, filter }) => json(await saveFilter(name, filter)),
  );

  const sourceIds = listSources().map((source) => source.id);

  server.registerTool(
    'run_source',
    {
      description: `Run one source now and return its counts. Sources: ${sourceIds.join(', ')}. Boards only set the hiring signal on companies, catalogs add companies, lead sources (prozorro, ain, devua) add tenders and funding news.`,
      inputSchema: {
        id: z.string(),
        limit: z.number().int().min(1).optional(),
        slug: z.string().optional().describe('For ATS boards: one company slug; for getro: one network'),
      },
      annotations: { ...write, openWorldHint: true },
    },
    async ({ id, limit, slug }) => {
      const source = getSource(id);
      if (!source) return fail(`unknown source ${id}, known: ${sourceIds.join(', ')}`);
      return json(await runSource(id, { limit, slug }));
    },
  );

  server.registerTool(
    'list_leads',
    {
      description:
        'Explicit demand: open tenders (prozorro) by deadline, nearest first, then funding news (ain, devua). ' +
        'A news lead has no company yet: the startup is named only in the headline.',
      inputSchema: {
        source: z.string().optional().describe('prozorro, ain, devua'),
        status: z.enum(LEAD_STATUSES).optional(),
        includeClosed: z.boolean().default(false).describe('Also expired tenders'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: read,
    },
    async ({ source, status, includeClosed, limit }) =>
      json(
        (await listLeads({ source, status, open: !includeClosed, limit })).map(({ text, ...row }) => ({
          ...row,
          text: text && text.length > 400 ? `${text.slice(0, 400)}...` : text,
        })),
      ),
  );

  server.registerTool(
    'set_lead_status',
    {
      description: 'Mark a lead interesting, contacted or skipped. The company status is separate, see set_status.',
      inputSchema: { id: z.number().int(), status: z.enum(LEAD_STATUSES) },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ id, status }) => json(await setLeadStatus(id, status)),
  );

  return server;
}
