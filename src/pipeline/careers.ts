import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, type Company } from '../db/schema.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import type { RawVacancy } from '../sources/registry.js';
import { dedupeKey } from './dedupe.js';
import { closeMissing, ingestVacancies, type IngestStats } from './ingest.js';
import type { PageBlock } from './normalize.js';
import { saveSnapshot } from './snapshots.js';
import { fetchDetail } from './sync.js';

/**
 * Own career pages of companies without an ATS (CLAUDE.md, priority 4 and section 8).
 *
 * The normalize, block diff and snapshot chain existed, but nothing ran it on a schedule:
 * only `page:check` did, by hand. So companies with a plain HTML careers page were found once
 * by discovery and never looked at again.
 *
 * One pass: the page, a snapshot, every block through the same ingest as the boards (stop
 * words, role check, model only for what survives), then vacancies whose block is gone get
 * closed. Companies the owner marked interesting or new are due daily, the rest every three
 * days, the longest unchecked first.
 */

export const CAREERS_SOURCE = 'careers';
const DAY = 86_400_000;

export interface CareersResult {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  checked: number;
  closed: number;
}

/** The blocks of a page as vacancies of that company. Pure, for tests. */
export function blocksToVacancies(company: Pick<Company, 'name' | 'domain'>, pageUrl: string, blocks: PageBlock[]): RawVacancy[] {
  return blocks
    .filter((block) => block.title)
    .map((block) => {
      let url = pageUrl;
      if (block.url) {
        try {
          url = new URL(block.url, pageUrl).toString();
        } catch {
          // A broken href: the page itself is still a working link.
        }
      }
      return {
        source: CAREERS_SOURCE,
        externalId: block.hash,
        url,
        title: block.title,
        rawText: block.text,
        companyName: company.name,
        companyDomain: company.domain,
        location: null,
        remote: null,
        postedAt: null,
      };
    });
}

async function dueCompanies(limit: number, now: number): Promise<Company[]> {
  const db = getDb();
  const rows = await db
    .select({ company: companies, status: companyState.status })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      and(
        eq(companies.careersKind, 'html'),
        or(isNull(companies.lastChecked), lt(companies.lastChecked, now - DAY + 3_600_000)),
      ),
    )
    .orderBy(asc(companies.lastChecked));

  const hidden = new Set(['blacklist', 'rejected_by_me', 'rejected_by_them']);
  return rows
    .filter((row) => row.company.careersUrl && !hidden.has(row.status ?? 'new'))
    .filter((row) => {
      const eager = ['new', 'interesting'].includes(row.status ?? 'new');
      const period = eager ? DAY : 3 * DAY;
      return !row.company.lastChecked || row.company.lastChecked < now - period + 3_600_000;
    })
    .slice(0, limit)
    .map((row) => row.company);
}

export async function syncCareers(options: { limit?: number; skipLlm?: boolean } = {}): Promise<CareersResult> {
  return withRun(CAREERS_SOURCE, async () => {
    const targets = await dueCompanies(options.limit ?? 30, Date.now());
    const errors: string[] = [];
    let found = 0;
    let created = 0;
    let closed = 0;

    for (const company of targets) {
      try {
        const { body } = await fetchText(company.careersUrl!);
        const { page } = await saveSnapshot(company.id, company.careersUrl!, body);
        const items = blocksToVacancies(company, company.careersUrl!, page.blocks);
        found += items.length;

        const stats: IngestStats = await ingestVacancies(items, { skipLlm: options.skipLlm, fetchDetail }, company);
        created += stats.created;

        /*
         * An empty page is a broken page (a redesign, a JS shell, a block), not a company that
         * closed every role at once. Closing on it would wipe the history, so it is an error.
         */
        if (items.length === 0) {
          errors.push(`${company.domain}: no vacancy blocks on ${company.careersUrl}`);
          continue;
        }
        const keys = items.map((item) => dedupeKey({ domain: company.domain, title: item.title, url: item.url }));
        closed += await closeMissing(company.id, CAREERS_SOURCE, keys);
      } catch (error) {
        const message = `${company.domain}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        log.warn({ source: CAREERS_SOURCE, err: message }, 'career page failed, moving on');
        // Checked, even if unsuccessfully: otherwise a dead page stays first in line forever.
        await getDb().update(companies).set({ lastChecked: Date.now() }).where(eq(companies.id, company.id));
      }
    }

    return { itemsFound: found, itemsNew: created, errors, checked: targets.length, closed };
  });
}
