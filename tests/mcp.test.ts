import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/api/index.js';
import { config, setRuntimeEnv } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { templates, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { rememberContact } from '../src/pipeline/outreach.js';

/**
 * The MCP server through a real SDK client. Requests go into the Hono app in process, so the
 * route, the bearer check and the transport are all exercised, with no port and no network.
 */

const TOKEN = 'test-mcp-token';
const URL_MCP = 'http://127.0.0.1:3000/mcp';

const inProcess = (input: string | URL | Request, init?: RequestInit) =>
  app.request(input instanceof Request ? input : String(input), init);

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_MCP), {
      fetch: inProcess as typeof fetch,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

let studio: Company;

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  const { sqlite } = runMigrations();
  sqlite.close();

  setRuntimeEnv({ RADAR_TOKEN: TOKEN });

  ({ company: studio } = await upsertCompany({
    name: 'Pixel Studio',
    domain: 'pixel.studio',
    country: 'Ukraine',
    source: 'test',
    kind: 'studio',
  }));
  await rememberContact(studio.id, 'olena@pixel.studio', 'Olena Koval', 'CEO');

  await getDb().insert(templates).values({
    slug: 'named_uk',
    name: 'Named, Ukrainian',
    kind: 'studio',
    language: 'uk',
    targetType: 'studio_named',
    subject: 'Для {{company}}',
    body: 'Привіт, {{first_name|колеги}}! Лист для {{company}}.',
  });
});

afterAll(() => setRuntimeEnv({ RADAR_TOKEN: '' }));

describe('MCP access', () => {
  it('a wrong token is refused with 401', async () => {
    const response = await app.request(URL_MCP, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('the token in a query string is not accepted, only the header', async () => {
    const response = await app.request(`${URL_MCP}?token=${TOKEN}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('without RADAR_TOKEN the endpoint stays closed, even locally', async () => {
    setRuntimeEnv({ RADAR_TOKEN: '' });
    try {
      const response = await app.request(URL_MCP, { method: 'POST', body: '{}' });
      expect(response.status).toBe(503);
    } finally {
      setRuntimeEnv({ RADAR_TOKEN: TOKEN });
    }
  });
});

describe('MCP tools', () => {
  it('lists the tools from CLAUDE.md and no send tool', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_companies',
        'get_company',
        'set_status',
        'add_note',
        'add_contact',
        'list_templates',
        'get_template',
        'upsert_template',
        'preview_letter',
        'create_draft',
        'list_outreach',
        'get_settings',
        'update_settings',
        'run_source',
        'stats',
        'list_saved_filters',
        'save_filter',
        'daily_queue',
        'list_leads',
        'set_lead_status',
      ]),
    );
    expect(names.some((name) => /send/i.test(name))).toBe(false);
  });

  it('search_companies returns compact cards with the named contact', async () => {
    const client = await connect();
    const { data } = await call(client, 'search_companies', { minScore: -1000 });
    const card = data.companies.find((row: { id: number }) => row.id === studio.id);
    expect(card.contact).toEqual({ name: 'Olena Koval', role: 'CEO', email: 'olena@pixel.studio' });
    expect(card.description).toBeUndefined();
  });

  it('save_filter stores a query that search_companies can start from', async () => {
    const client = await connect();
    const saved = await call(client, 'save_filter', { name: 'UA studios', filter: { market: 'ua', kind: ['studio'] } });
    expect(saved.data.before).toBeNull();
    expect(saved.data.after.query).toEqual({ market: 'ua', kind: ['studio'] });

    const listed = await call(client, 'list_saved_filters');
    expect(listed.data.map((row: { name: string }) => row.name)).toContain('UA studios');

    const found = await call(client, 'search_companies', { savedFilter: 'ua studios', minScore: -1000 });
    expect(found.data.filter).toEqual({ market: 'ua', kind: ['studio'], minScore: -1000 });
    expect(found.data.companies.map((row: { id: number }) => row.id)).toEqual([studio.id]);

    const intl = await call(client, 'search_companies', { savedFilter: 'UA studios', market: 'intl', minScore: -1000 });
    expect(intl.data.companies).toEqual([]);

    expect((await call(client, 'search_companies', { savedFilter: 'nope' })).isError).toBe(true);
  });

  it('get_company leaves the embedding out', async () => {
    const client = await connect();
    const { data } = await call(client, 'get_company', { id: studio.id });
    expect(data.company.name).toBe('Pixel Studio');
    expect('embedding' in data.company).toBe(false);
    expect(data.contacts).toHaveLength(1);
  });

  it('an unknown company is a tool error, not a crash', async () => {
    const client = await connect();
    const result = await call(client, 'get_company', { id: 999_999 });
    expect(result.isError).toBe(true);
  });

  it('set_status returns before and after, and never downgrades a contacted company', async () => {
    const client = await connect();
    const first = await call(client, 'set_status', { companyId: studio.id, status: 'contacted' });
    expect(first.data.before.status).toBe('new');
    expect(first.data.after.status).toBe('contacted');

    const second = await call(client, 'set_status', { companyId: studio.id, status: 'interesting' });
    expect(second.data.after.status).toBe('contacted');
    expect(second.data.kept).toMatch(/never downgrades/);

    await call(client, 'set_status', { companyId: studio.id, status: 'new' });
  });

  it('add_note appends a dated line and keeps the status', async () => {
    const client = await connect();
    await call(client, 'add_note', { companyId: studio.id, text: 'first call went well' });
    const { data } = await call(client, 'add_note', { companyId: studio.id, text: 'wants a quote' });
    expect(data.after.status).toBe('new');
    expect(data.after.reason).toMatch(/\d{4}-\d{2}-\d{2}: first call went well\n\d{4}-\d{2}-\d{2}: wants a quote$/);
  });

  it('add_contact refuses an invalid address and shows the new row', async () => {
    const client = await connect();
    expect((await call(client, 'add_contact', { companyId: studio.id, email: 'not an email' })).isError).toBe(true);

    const { data } = await call(client, 'add_contact', { companyId: studio.id, email: 'Hello@Pixel.Studio' });
    expect(data.created).toBe(true);
    expect(data.before).toBeNull();
    expect(data.after.email).toBe('hello@pixel.studio');
  });

  it('preview_letter fills the template and writes nothing', async () => {
    const client = await connect();
    const { data } = await call(client, 'preview_letter', { companyId: studio.id });
    expect(data.templateSlug).toBe('named_uk');
    expect(data.subject).toBe('Для Pixel Studio');
    expect(data.body).toContain('Привіт, Olena!');

    const drafts = await call(client, 'list_outreach', { status: 'draft' });
    expect(drafts.data).toEqual([]);
  });

  it('upsert_template creates, then edits by slug and returns only changed fields', async () => {
    const client = await connect();
    const created = await call(client, 'upsert_template', { name: 'Follow-up UA', language: 'uk', body: 'Нагадую.' });
    expect(created.data.created).toBe(true);
    const slug = created.data.after.slug;

    const edited = await call(client, 'upsert_template', { slug, body: 'Нагадую ще раз.' });
    expect(edited.data.created).toBe(false);
    expect(edited.data.changed).toEqual({ body: { before: 'Нагадую.', after: 'Нагадую ще раз.' } });
  });

  it('update_settings merges a partial rules object and lists the changed paths', async () => {
    const client = await connect();
    const { data: settings } = await call(client, 'get_settings');
    const threshold = settings.rules.companies.threshold as number;

    const { data } = await call(client, 'update_settings', {
      rules: { companies: { threshold: threshold + 5 } },
      signature: 'Test signature',
    });
    expect(data.changes).toEqual(
      expect.arrayContaining([
        { path: 'rules.companies.threshold', before: threshold, after: threshold + 5 },
        { path: 'signature', before: '', after: 'Test signature' },
      ]),
    );
    expect(data.changes).toHaveLength(2);
  });

  it('run_source refuses an unknown source with the list of known ones', async () => {
    const client = await connect();
    const result = await call(client, 'run_source', { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/known: .*dou/);
  });
});
