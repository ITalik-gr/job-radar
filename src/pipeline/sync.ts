import { eq } from 'drizzle-orm';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { getDb } from '../db/client.js';
import { companies, type Company } from '../db/schema.js';
import { getSource } from '../sources/registry.js';
import { companiesForAts } from './companies.js';
import { recordHiring, type HiringStats } from './hiring.js';

export interface SyncOptions {
  slug?: string;
  limit?: number;
}

export interface SyncResult extends HiringStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
}

/**
 * A pass over a board: postings in, hiring signal and new companies out. Nothing about the
 * postings themselves is stored, see `hiring.ts`.
 */
export async function syncSource(id: string, options: SyncOptions = {}): Promise<SyncResult> {
  const source = getSource(id);
  if (!source) throw new Error(`unknown source: ${id}`);
  if (source.kind !== 'board') throw new Error(`source ${id} is not a board`);

  return withRun(id, async () => {
    const errors: string[] = [];
    const totals: HiringStats = { seen: 0, companies: 0, created: 0, hiring: 0, skipped: 0 };
    let found = 0;

    const add = (stats: HiringStats) => {
      for (const key of Object.keys(totals) as (keyof HiringStats)[]) totals[key] += stats[key];
    };

    if (source.requiresSlug) {
      const targets: { slug: string; company?: Company }[] = options.slug
        ? [{ slug: options.slug }]
        : (await companiesForAts(id)).map((company) => ({ slug: company.careersSlug!, company }));

      if (targets.length === 0) log.warn({ source: id }, 'no companies with this ATS');

      for (const target of targets.slice(0, options.limit ?? targets.length)) {
        try {
          const items = await source.fetch(target);
          found += items.length;
          add(await recordHiring(items, target.company));
        } catch (error) {
          const message = `${target.slug}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          log.warn({ source: id, err: message }, 'error on one slug, moving on');
        }
      }
    } else {
      /*
       * A slug isn't required here, but it's passed anyway: Getro reads it as a network id and
       * does only that one network per call. The other sources don't notice this field.
       */
      const items = await source.fetch({ slug: options.slug });
      found += items.length;
      add(await recordHiring(items.slice(0, options.limit ?? items.length)));
    }

    return { ...totals, itemsFound: found, itemsNew: totals.created, errors };
  });
}

export async function companyByDomain(domain: string): Promise<Company | undefined> {
  const [row] = await getDb().select().from(companies).where(eq(companies.domain, domain));
  return row;
}
