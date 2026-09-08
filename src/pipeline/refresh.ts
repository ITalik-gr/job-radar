import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, contacts } from '../db/schema.js';
import { log } from '../lib/log.js';
import { discoverCompany } from './discover.js';
import { enrichCompany, saveEnrichment } from './enrich.js';

/**
 * Повний перегляд однієї компанії по кнопці.
 *
 * Це те саме, що роблять нічні проходи, але для однієї компанії і **без умов**:
 * discovery і enrichment запускаються навіть тоді, коли компанію вже дивились.
 * Причина в тому, як влаштований збір: каталог дає лише картку, а на сам сайт
 * заходять окремі кроки за розкладом, тому конкретна студія, яку власник дивиться
 * прямо зараз, може чекати своєї черги днями.
 *
 * Звіт повертається докладний навмисно. Кнопкою перевіряють, чи працює пошук, а
 * "оновлено" без подробиць нічого не каже: незрозуміло, чи сайт відкрився, чи
 * знайшлась пошта, чи стек взявся з тексту сторінки послуг.
 */
export interface RefreshReport {
  companyId: number;
  domain: string;
  /** Головна відкрилась серверу. false означає 403 від захисту, таймаут або мертвий домен. */
  reachable: boolean;
  /** Сторінка це порожній каркас: вміст малює скрипт уже в браузері. */
  clientRendered: boolean;
  /** Домен чекає на розширення: сервер сам його не прочитає. */
  needsBrowser: boolean;
  pagesFetched: number;
  careersUrl: string | null;
  careersKind: string;
  careersSlug: string | null;
  /** Увесь стек компанії після оновлення і те, що додалось саме зараз. */
  techHints: string[];
  techAdded: string[];
  contactsAdded: number;
  /** Адреси, які видно на сайті. Показуються як є: власник має бачити, що знайшлось. */
  emails: string[];
  people: number;
}

export async function refreshCompany(companyId: number): Promise<RefreshReport> {
  const db = getDb();
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`компанії ${companyId} немає`);

  const techBefore = new Set(company.techHints);

  /*
   * Спершу discovery: він знаходить career-сторінку і впізнає ATS, і саме він
   * пише `careers_slug`, від якого залежить, чи прийдуть вакансії цієї компанії.
   * Порядок важливий і в дрібниці: enrichment далі бере вже оновлену картку.
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
    'компанію оновлено по кнопці',
  );

  return report;
}
