import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, companyState, siteAudits, type Company } from '../db/schema.js';
import { fetchText, HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { pickLanguage, type Language } from './outreach.js';

/**
 * Site audit, section 5 of CLAUDE.md: the concrete reason to write.
 *
 * One PageSpeed Insights call per site (mobile strategy) gives the performance score, LCP, the
 * viewport check and the final URL after redirects. Copyright year and platform are not fetched
 * again: enrichment already stored them on the company.
 *
 * Issues are letter-ready phrases in the letter language of the company (Ukrainian for UA, as
 * `pickLanguage` decides), because the first one goes straight into `{{finding}}`. Only measured
 * facts become issues: a field PageSpeed did not return stays null and says nothing (rule 6).
 */

const API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** A site is audited again after this long: a slow site rarely gets fixed within a quarter. */
export const REAUDIT_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** Google's own "poor" thresholds for mobile: LCP over 4 s, performance under 50. */
const SLOW_LCP_MS = 4000;
const POOR_SCORE = 50;
/** A footer two years behind is a site nobody touches. */
const STALE_COPYRIGHT_YEARS = 2;

/** Platforms worth naming on the card, in order of preference when several are detected. */
const CMS = [
  'wordpress',
  'tilda',
  'wix',
  'prom',
  'horoshop',
  'shopify',
  'webflow',
  'squarespace',
  'framer',
  'drupal',
  'magento',
  'next.js',
  'nuxt',
  'astro',
  'gatsby',
];

/** Companies not worth a PageSpeed call: the owner already decided about them. */
const SKIP_STATUSES = ['blacklist', 'rejected_by_me', 'rejected_by_them'];

/**
 * Lighthouse could not load the page: dead domain, timeout, a protection page. Not the radar's
 * fault and not worth retrying tomorrow, unlike a quota or key error.
 */
export class PageUnreachableError extends Error {}

export interface PageSpeedResult {
  finalUrl: string | null;
  /** 0 to 100, mobile. */
  perfScore: number | null;
  lcpMs: number | null;
  mobileOk: boolean | null;
  https: boolean | null;
}

interface LighthouseAudit {
  score?: number | null;
  numericValue?: number;
}

interface PageSpeedResponse {
  error?: { code?: number; message?: string };
  lighthouseResult?: {
    finalUrl?: string;
    finalDisplayedUrl?: string;
    runtimeError?: { code?: string; message?: string };
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, LighthouseAudit | undefined>;
  };
}

/**
 * The request URL. Plain http on purpose: the final URL then shows whether the site redirects to
 * https. The key goes in a header, never here: a failed request's URL ends up in the `runs` table.
 */
export function pageSpeedUrl(domain: string): string {
  const params = new URLSearchParams({ url: `http://${domain}`, strategy: 'mobile' });
  // The viewport audit sits in best practices since Lighthouse 12, not in performance.
  params.append('category', 'performance');
  params.append('category', 'best-practices');
  return `${API_URL}?${params}`;
}

export function parsePageSpeed(payload: string): PageSpeedResult {
  let response: PageSpeedResponse;
  try {
    response = JSON.parse(payload) as PageSpeedResponse;
  } catch (error) {
    throw new Error(`PageSpeed: response is not JSON, ${String(error).slice(0, 120)}`);
  }
  if (response.error) throw new Error(`PageSpeed ${response.error.code ?? ''}: ${response.error.message ?? 'error response'}`);

  const lighthouse = response.lighthouseResult;
  if (!lighthouse) throw new Error('PageSpeed: no lighthouseResult in the response');
  // Lighthouse could not load the page at all: there is nothing measured to store.
  if (lighthouse.runtimeError?.code && lighthouse.runtimeError.code !== 'NO_ERROR') {
    throw new PageUnreachableError(`PageSpeed: ${lighthouse.runtimeError.code} ${lighthouse.runtimeError.message ?? ''}`.trim());
  }

  const audits = lighthouse.audits ?? {};
  const finalUrl = lighthouse.finalDisplayedUrl ?? lighthouse.finalUrl ?? null;
  const score = lighthouse.categories?.performance?.score;
  const lcp = audits['largest-contentful-paint']?.numericValue;
  const viewport = audits.viewport?.score;
  const onHttps = audits['is-on-https']?.score;

  return {
    finalUrl,
    perfScore: typeof score === 'number' ? Math.round(score * 100) : null,
    lcpMs: typeof lcp === 'number' ? Math.round(lcp) : null,
    mobileOk: typeof viewport === 'number' ? viewport === 1 : null,
    // Where the site ended up decides https; the audit is a fallback, it also flags mixed content.
    https: finalUrl ? finalUrl.startsWith('https:') : typeof onHttps === 'number' ? onHttps === 1 : null,
  };
}

export function cmsFrom(techHints: string[]): string | null {
  return CMS.find((name) => techHints.includes(name)) ?? null;
}

export interface IssueInput extends PageSpeedResult {
  copyrightYear: number | null;
  /** The current year, a separate field so the stale copyright rule can be tested. */
  year?: number;
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10).replace('.', ',');
}

/**
 * Issues from the most to the least convincing for an owner of the site: a broken phone layout
 * is felt by every customer, an old footer only hints at neglect.
 */
export function auditIssues(input: IssueInput, language: Language): string[] {
  const uk = language === 'uk';
  const year = input.year ?? new Date().getFullYear();
  const issues: string[] = [];

  if (input.mobileOk === false) {
    issues.push(uk ? 'сайт не має мобільної версії' : 'the site has no mobile layout');
  }
  if (input.lcpMs !== null && input.lcpMs > SLOW_LCP_MS) {
    const value = uk ? seconds(input.lcpMs) : seconds(input.lcpMs).replace(',', '.');
    issues.push(uk ? `головна сторінка вантажиться ${value} с на телефоні` : `the home page takes ${value} s to load on a phone`);
  } else if (input.perfScore !== null && input.perfScore < POOR_SCORE) {
    issues.push(
      uk
        ? `PageSpeed оцінює швидкість сайту на телефоні в ${input.perfScore} зі 100`
        : `PageSpeed rates the site ${input.perfScore} out of 100 on a phone`,
    );
  }
  if (input.https === false) {
    issues.push(uk ? 'сайт відкривається без HTTPS' : 'the site opens without HTTPS');
  }
  if (input.copyrightYear !== null && year - input.copyrightYear >= STALE_COPYRIGHT_YEARS) {
    issues.push(
      uk ? `у футері досі copyright ${input.copyrightYear}` : `the footer still says copyright ${input.copyrightYear}`,
    );
  }

  return issues;
}

export async function runPageSpeed(domain: string): Promise<PageSpeedResult> {
  try {
    const response = await fetchText(pageSpeedUrl(domain), {
      // A keyed API used within its quota, not a site to crawl.
      ignoreRobots: true,
      headers: { 'x-goog-api-key': config.pagespeed.apiKey },
      retries: 1,
      // Lighthouse loads the whole page on a throttled phone: half a minute is normal.
      timeoutMs: 90_000,
    });
    return parsePageSpeed(response.body);
  } catch (error) {
    // Google explains a 4xx in the body: an unreachable site, a bad key, the quota.
    if (error instanceof HttpError) {
      const body = error.message.slice(error.message.indexOf(': ') + 2);
      const parsed = (() => {
        try {
          return (JSON.parse(body) as PageSpeedResponse).error?.message;
        } catch {
          return null;
        }
      })();
      const message = `PageSpeed ${error.status}: ${parsed ?? body}`;
      // Google answers 400 or 500 with this prefix when the page itself failed to load.
      if (/Lighthouse returned error/i.test(message)) throw new PageUnreachableError(message);
      throw new HttpError(message, error.status, error.url);
    }
    throw error;
  }
}

/** Has a site, no audit within a quarter, not rejected. Shared by the batch and its remaining count. */
function dueForAudit() {
  const db = getDb();
  const recent = db
    .select({ id: siteAudits.companyId })
    .from(siteAudits)
    .where(sql`${siteAudits.checkedAt} > ${Date.now() - REAUDIT_AFTER_MS}`);
  const rejected = db
    .select({ id: companyState.companyId })
    .from(companyState)
    .where(inArray(companyState.status, SKIP_STATUSES));
  return and(sql`${companies.domain} <> ''`, notInArray(companies.id, recent), notInArray(companies.id, rejected));
}

export interface AuditOptions {
  limit?: number;
  domain?: string;
}

/**
 * Who gets audited next. Businesses go first, a bad site is what is sold to them; agencies last, their
 * site is a business card and says little about whether they need a subcontractor.
 */
export async function candidatesForAudit(options: AuditOptions = {}): Promise<Company[]> {
  const db = getDb();
  if (options.domain) return db.select().from(companies).where(eq(companies.domain, options.domain));

  const priority = sql`case ${companies.kind}
      when 'smb' then 0
      when 'ecommerce' then 0
      when 'public' then 1
      when 'startup' then 2
      when 'unknown' then 3
      when 'product' then 5
      else 4
    end`;

  return db
    .select()
    .from(companies)
    .where(dueForAudit())
    .orderBy(priority, sql`case when ${companies.market} = 'ua' then 0 else 1 end`, companies.id)
    .limit(options.limit ?? 10);
}

export async function saveAudit(company: Company, result: PageSpeedResult, now = Date.now()) {
  const issues = auditIssues(
    { ...result, copyrightYear: company.copyrightYear, year: new Date(now).getFullYear() },
    pickLanguage(company.country),
  );
  const row = {
    companyId: company.id,
    checkedAt: now,
    url: result.finalUrl ?? `http://${company.domain}`,
    https: result.https,
    mobileOk: result.mobileOk,
    perfScore: result.perfScore,
    lcpMs: result.lcpMs,
    cms: cmsFrom(company.techHints),
    copyrightYear: company.copyrightYear,
    issues,
  };
  await getDb().insert(siteAudits).values(row);
  return row;
}

export interface AuditStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  audited: number;
  withIssues: number;
  remaining: number;
}

export async function audit(options: AuditOptions = {}): Promise<AuditStats> {
  if (!config.pagespeed.apiKey) {
    throw new Error('PAGESPEED_API_KEY is not set, the site audit is off (the keyless quota is zero)');
  }

  return withRun('audit', async () => {
    const targets = await candidatesForAudit(options);
    const stats: AuditStats = { itemsFound: targets.length, itemsNew: 0, errors: [], audited: 0, withIssues: 0, remaining: 0 };

    for (const company of targets) {
      try {
        const saved = await saveAudit(company, await runPageSpeed(company.domain));
        stats.audited += 1;
        stats.itemsNew += 1;
        if (saved.issues.length > 0) stats.withIssues += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.errors.push(`${company.domain}: ${message}`);
        /*
         * An empty audit row, so the company waits a quarter instead of heading every next batch.
         * No speed or layout issue is claimed: a page Google could not open may open for a person.
         */
        if (error instanceof PageUnreachableError) {
          await saveAudit(company, { finalUrl: null, perfScore: null, lcpMs: null, mobileOk: null, https: null });
        }
        log.warn({ domain: company.domain, err: message }, 'site audit failed');
        // The quota or the key is gone: every next call would fail the same way.
        if (error instanceof HttpError && (error.status === 429 || error.status === 403)) break;
      }
    }

    if (!options.domain) {
      const [left] = await getDb()
        .select({ count: sql<number>`count(*)` })
        .from(companies)
        .where(dueForAudit());
      stats.remaining = left?.count ?? 0;
    }
    return stats;
  });
}
