import { fetchJson, fetchText } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { normalizeDomain } from '../../lib/normalize.js';
import type { LeadSource, RawLead } from '../registry.js';

/**
 * Prozorro, the Ukrainian public procurement system, section 4 of CLAUDE.md. An open tender for
 * software or a site is explicit demand: the buyer is the company, the tender is a `leads` row
 * with a deadline.
 *
 * Three public endpoints, because none of them alone has everything:
 *
 *   1. the prozorro.gov.ua search (POST): filters by CPV code and status, gives the title,
 *      budget and deadline, but no buyer code and no internal id;
 *   2. the tender summary on the same site: turns a UA-... tender id into the internal id;
 *   3. the official API (public.api.openprocurement.org): the full tender by internal id, with
 *      the buyer's ЄДРПОУ, address and contact person.
 *
 * The official API alone cannot filter by CPV, its feed only lists ids. Titles are filtered here
 * before any detail request, so a run costs two requests per tender that looks like development
 * work, not per tender in the country.
 */

const SOURCE = 'prozorro';
const SEARCH_URL = 'https://prozorro.gov.ua/api/search/tenders';
const SUMMARY_URL = 'https://prozorro.gov.ua/api/tenders';
const TENDER_URL = 'https://public.api.openprocurement.org/api/2.5/tenders';

/**
 * ДК 021:2015 codes for software and web work. The search matches codes exactly, not by prefix,
 * so every useful child of 72000000 is listed. Hosting, data and consulting codes are left out.
 */
export const CPV_CODES = [
  '72200000-7', // software programming and consultancy
  '72210000-0', // programming of packaged software
  '72212000-4', // programming of application software
  '72230000-6', // custom software development
  '72260000-5', // software related services (mostly licences, hence the title filter)
  '72262000-9', // software development services
  '72263000-6', // software implementation
  '72400000-4', // internet services
  '72410000-7', // provider services
  '72413000-8', // world wide web site design
  '72420000-3', // internet development
  '72421000-0', // internet or intranet client application development
  '72422000-7', // internet or intranet server application development
];

/** A run reads at most this many search pages of 20, so a busy week cannot exhaust the worker. */
const MAX_PAGES = 5;
/** And fetches details for at most this many tenders. */
const MAX_DETAILS = 25;

/** Development work: building or changing something, not buying a licence. */
const DEV_WORDS =
  /(розроб|створенн|доопрацюв|модерніз|вдосконал|сайт|портал|мобільн\S* (додат|застосун)|застосунк|чат-?бот|реалізаці\S* модул|інформаційн\S* (систем|ресурс)|автоматизован\S* систем)/i;
/** Buying, renewing or supporting what exists: licences, subscriptions, support contracts. */
const NOT_DEV =
  /(ліценз|право користування|постачання|антивірус|microsoft|ms office|підписк|deepl|сертифікат|технічн\S* підтримк|супровод|адмініструванн|віртуаліз)/i;

export function isDevTender(title: string): boolean {
  return DEV_WORDS.test(title) && !NOT_DEV.test(title);
}

export interface SearchHit {
  tenderID: string;
  title: string;
}

interface SearchPage {
  page: number;
  per_page: number;
  total: number;
  data: { tenderID?: string; title?: string; status?: string }[];
}

export function parseSearch(payload: string): { hits: SearchHit[]; total: number } {
  let page: SearchPage;
  try {
    page = JSON.parse(payload) as SearchPage;
  } catch (error) {
    throw new Error(`Prozorro: search response is not JSON, ${String(error).slice(0, 120)}`);
  }
  if (!Array.isArray(page.data)) throw new Error('Prozorro: search response has no data array');
  const hits = page.data
    .filter((row): row is { tenderID: string; title: string } => Boolean(row.tenderID && row.title))
    .map((row) => ({ tenderID: row.tenderID, title: row.title.trim() }));
  return { hits, total: page.total ?? hits.length };
}

export function parseSummary(payload: string): string {
  const summary = JSON.parse(payload) as { id?: string };
  if (!summary.id) throw new Error('Prozorro: tender summary has no id');
  return summary.id;
}

interface Tender {
  id: string;
  tenderID: string;
  title: string;
  description?: string;
  status?: string;
  value?: { amount?: number; currency?: string };
  tenderPeriod?: { endDate?: string };
  procuringEntity?: {
    name?: string;
    identifier?: { scheme?: string; id?: string; legalName?: string; uri?: string };
    address?: { streetAddress?: string; locality?: string; region?: string };
    contactPoint?: { name?: string; email?: string; telephone?: string; url?: string };
  };
}

/** "місто Харків", "м. Київ" are written as the bare city. */
export function cleanLocality(value: string | null | undefined): string | null {
  const city = (value ?? '').replace(/^(місто|м\.)\s*/i, '').trim();
  return city || null;
}

/** "380444650931" and "+38 (044) 465-09-31" both become +380444650931. */
export function cleanPhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  if (digits.startsWith('380')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+38${digits}`;
  return `+${digits}`;
}

/** The full tender from the official API as a lead with its buyer and contact person. */
export function parseTender(payload: string): RawLead {
  let tender: Tender;
  try {
    tender = (JSON.parse(payload) as { data: Tender }).data;
  } catch (error) {
    throw new Error(`Prozorro: tender response is not JSON, ${String(error).slice(0, 120)}`);
  }
  if (!tender?.tenderID || !tender.title) throw new Error('Prozorro: tender has no id or title');

  const buyer = tender.procuringEntity ?? {};
  const identifier = buyer.identifier ?? {};
  const registryCode = identifier.scheme === 'UA-EDR' && identifier.id ? identifier.id : null;
  const contact = buyer.contactPoint ?? {};
  const deadline = tender.tenderPeriod?.endDate ? Date.parse(tender.tenderPeriod.endDate) : NaN;
  const url = `https://prozorro.gov.ua/tender/${tender.tenderID}`;

  const name = (buyer.name || identifier.legalName || '').trim();
  return {
    source: SOURCE,
    externalId: tender.tenderID,
    url,
    title: tender.title.trim(),
    text: tender.description?.trim() || null,
    budget: tender.value?.amount ?? null,
    currency: tender.value?.currency ?? null,
    deadlineAt: Number.isFinite(deadline) ? deadline : null,
    company: name
      ? {
          source: SOURCE,
          name,
          // The site the buyer stated about itself, often the parent body's.
          domain: normalizeDomain(identifier.uri ?? contact.url ?? ''),
          registryCode,
          country: 'UA',
          city: cleanLocality(buyer.address?.locality),
          address: [buyer.address?.streetAddress, cleanLocality(buyer.address?.locality)].filter(Boolean).join(', ') || null,
          kind: 'public',
          sizeHint: null,
          careersUrl: null,
          sourceUrl: url,
          tags: [],
          description: null,
          openVacancies: null,
        }
      : null,
    contact:
      contact.name || contact.email || contact.telephone
        ? {
            name: contact.name?.trim() || null,
            role: 'tender contact person',
            email: contact.email?.trim().toLowerCase() || null,
            phone: cleanPhone(contact.telephone),
          }
        : null,
  };
}

async function search(page: number): Promise<{ hits: SearchHit[]; total: number }> {
  const response = await fetchText(SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ cpv: CPV_CODES, status: ['active.tendering'], page }),
  });
  return parseSearch(response.body);
}

export const prozorro: LeadSource = {
  id: SOURCE,
  kind: 'lead',
  async fetch() {
    const hits: SearchHit[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await search(page);
      hits.push(...result.hits);
      if (result.hits.length === 0 || hits.length >= result.total) break;
    }

    const wanted = hits.filter((hit) => isDevTender(hit.title));
    log.info({ found: hits.length, dev: wanted.length }, 'Prozorro search done');

    const leads: RawLead[] = [];
    for (const hit of wanted.slice(0, MAX_DETAILS)) {
      try {
        const id = parseSummary((await fetchText(`${SUMMARY_URL}/${hit.tenderID}/summary`)).body);
        const full = await fetchJson(`${TENDER_URL}/${id}`);
        leads.push(parseTender(JSON.stringify(full)));
      } catch (error) {
        log.warn({ tender: hit.tenderID, err: String(error) }, 'Prozorro tender skipped');
      }
    }
    return { leads, seen: hits.length };
  },
  parse(payload: string) {
    return [parseTender(payload)];
  },
};
