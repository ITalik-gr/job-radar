import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, contacts } from '../db/schema.js';
import { log } from '../lib/log.js';
import { discoverCompany } from './discover.js';
import { enrichCompany, saveEnrichment } from './enrich.js';

/**
 * A full review of one company from a button press.
 *
 * This is the same thing the nightly passes do, but for one company and **with no
 * conditions**: discovery and enrichment run even when the company has already been
 * looked at. The reason lies in how collection is built: a catalog only gives a card,
 * and the site itself is visited by separate scheduled steps, so a specific studio the
 * owner is looking at right now might sit in the queue for days.
 *
 * The report is deliberately detailed. A button press is used to check whether the
 * search works at all, and "updated" with no details says nothing: it's unclear
 * whether the site even opened, whether an address was found, or whether the stack
 * came from the text of the services page.
 */
export interface RefreshReport {
  companyId: number;
  domain: string;
  /** The home page opened for the server. false means 403 from protection, a timeout, or a dead domain. */
  reachable: boolean;
  /** The page is an empty shell: the content is drawn by script already in the browser. */
  clientRendered: boolean;
  /** The domain is waiting on the extension: the server can't read it itself. */
  needsBrowser: boolean;
  pagesFetched: number;
  careersUrl: string | null;
  careersKind: string;
  careersSlug: string | null;
  /** The company's whole stack after the update, and what was added just now. */
  techHints: string[];
  techAdded: string[];
  contactsAdded: number;
  /** Addresses visible on the site. Shown as is: the owner has to see what was found. */
  emails: string[];
  people: number;
}

export async function refreshCompany(companyId: number): Promise<RefreshReport> {
  const db = getDb();
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`company ${companyId} does not exist`);

  const techBefore = new Set(company.techHints);

  /*
   * Discovery first: it finds the careers page and recognizes the ATS, and it's the
   * one that writes `careers_slug`, which decides whether this company's vacancies
   * will come in at all. The order matters even in the details: enrichment next uses the already updated card.
   */
  const discovery = await discoverCompany(company);
  await db
    .update(companies)
    .set({
      careersUrl: discovery.careersUrl,
      careersKind: discovery.careersKind,
      careersSlug: discovery.careersSlug,
      techHints: discovery.techHints,
      lastChecked: Date.now(),
    })
    .where(eq(companies.id, company.id));

  const [updated] = await db.select().from(companies).where(eq(companies.id, company.id));
  const enrichment = await enrichCompany(updated!);
  const saved = await saveEnrichment(enrichment);

  const [after] = await db.select().from(companies).where(eq(companies.id, company.id));
  const rows = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

  const report: RefreshReport = {
    companyId: company.id,
    domain: company.domain,
    reachable: enrichment.reachable,
    clientRendered: enrichment.clientRendered,
    needsBrowser: after!.needsBrowser,
    pagesFetched: discovery.attempts + enrichment.pagesFetched,
    careersUrl: after!.careersUrl,
    careersKind: after!.careersKind,
    careersSlug: after!.careersSlug,
    techHints: after!.techHints,
    techAdded: after!.techHints.filter((item) => !techBefore.has(item)),
    contactsAdded: saved.added,
    emails: rows.map((row) => row.email).filter((email): email is string => Boolean(email)),
    people: rows.filter((row) => row.name).length,
  };

  log.info(
    { domain: company.domain, pages: report.pagesFetched, contacts: report.contactsAdded },
    'company refreshed from the button',
  );

  return report;
}
