import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, snapshots } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { lastSnapshot, saveSnapshot } from '../src/pipeline/snapshots.js';

const html = (name: string) => readFileSync(`fixtures/careers/${name}.html`, 'utf8');
const URL = 'https://acme.studio/careers';
let companyId: number;

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  const { company } = await upsertCompany({ name: 'Acme Studio', domain: 'acme.studio', source: 'test' });
  companyId = company.id;
});

describe('saveSnapshot', () => {
  it('перший знімок позначається як first, усі блоки нові', async () => {
    const result = await saveSnapshot(companyId, URL, html('acme-v1'));
    expect(result.first).toBe(true);
    expect(result.diff.added).toHaveLength(4);
    expect(result.snapshot.blockHashes).toHaveLength(4);
    expect(result.snapshot.textNormalized).toContain('senior frontend engineer');
  });

  it('той самий вміст з іншим шумом не вважається зміною', async () => {
    const result = await saveSnapshot(companyId, URL, html('acme-v1-noise'));
    expect(result.diff.changed).toBe(false);
    expect(result.noiseOnly).toBe(false);
    expect(result.first).toBe(false);
  });

  it('реальна зміна дає одну нову і одну зниклу вакансію і оновлює last_change_at', async () => {
    const result = await saveSnapshot(companyId, URL, html('acme-v2'));
    expect(result.diff.added.map((b) => b.url)).toEqual(['/careers/full-stack-engineer-ai']);
    expect(result.diff.removed).toHaveLength(1);

    const [company] = await getDb().select().from(companies).where(eq(companies.id, companyId));
    expect(company!.lastChangeAt).toBeGreaterThan(0);
    expect(company!.lastChecked).toBeGreaterThan(0);
  });

  it('останній знімок це справді останній', async () => {
    const snapshot = await lastSnapshot(companyId, URL);
    expect(snapshot!.blockHashes).toHaveLength(4);
    expect(snapshot!.textNormalized).toContain('full-stack engineer');
  });

  it('на компанію лишається не більше пʼяти знімків', async () => {
    for (let i = 0; i < 5; i += 1) await saveSnapshot(companyId, URL, html('acme-v2'));
    const rows = await getDb().select().from(snapshots).where(eq(snapshots.companyId, companyId));
    expect(rows).toHaveLength(config.pipeline.snapshotsPerCompany);
  });

  it('різні URL однієї компанії живуть окремо', async () => {
    const other = await saveSnapshot(companyId, `${URL}/design`, html('acme-v1'));
    expect(other.first).toBe(true);
  });
});
