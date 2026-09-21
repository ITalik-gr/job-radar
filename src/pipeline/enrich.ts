import * as cheerio from 'cheerio';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, contacts, type Company } from '../db/schema.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { normalizeDomain } from '../lib/normalize.js';
import { withRun } from '../lib/runs.js';
import { detectStack } from './discover.js';
import { normalizeEmail, rememberContact } from './outreach.js';

/**
 * Collecting contacts and signs of life from a company site.
 *
 * Why: the database has hundreds of studios, and almost every card says "no named contacts".
 * A list without an address leads nowhere, and a letter to hello@ is read by a manager, not a tech lead.
 *
 * No model is called here at all, deliberately: named contacts are parsed out of HTML with
 * regexes over the flattened text, so a pass over the whole database costs nothing.
 * Section 9 of CLAUDE.md describes exactly this kind of collection.
 */

/** Pages where the team and contacts live. Ordered from most to least valuable. */
/**
 * Service pages. People are not collected from them, but the stack is: a studio describes
 * there in words what it does for clients, and that often differs from what its own site is
 * built on. A shop that builds headless stores may itself run on WordPress.
 */
export const SERVICE_PATHS = [
  '/services',
  '/what-we-do',
  '/expertise',
  '/technologies',
  '/tech-stack',
  '/solutions',
  '/capabilities',
];

export const TEAM_PATHS = [
  '/team',
  '/our-team',
  '/about-us',
  '/about',
  '/people',
  '/company',
  '/leadership',
  '/contacts',
  '/contact',
  '/contact-us',
];

/**
 * Menu links that lead to the same pages under other addresses. The Ukrainian words are
 * matched on purpose: Ukrainian studio sites label these links in Ukrainian.
 */
const TEAM_TEXT = /(team|about|people|leadership|contact|команда|про нас|контакт)/i;

/*
 * Acronyms match only in upper case and on word boundaries. Without that "coo" was found
 * inside "cookie" and gave 130 false matches per page, because the cookie banner is everywhere.
 */
const ROLE_ACRONYM = /\b(?:CTO|CEO|COO|CPO|CIO|CMO|VP)\b/;
const ROLE_PHRASE =
  /\b(?:co-?founder|founder|tech(?:nical)? lead|team lead|head of [a-z/& ]{2,24}|engineering manager|lead (?:developer|engineer)|managing director|delivery manager)\b/i;

/*
 * A role at another company means an investor or a testimonial, not a member of this team.
 * Product landing pages have dozens of such blocks: "Nat Friedman, Former CEO of GitHub".
 * The first run over ten companies brought 104 contacts, and most of them came from there.
 */
const FOREIGN_ROLE = /\b(?:former|ex-|previously|investor|advisor|board member)\b/i;

/**
 * "CEO of Sentry", "Head of Engineering, Ramp", "Co-Founder @ FPV Ventures":
 * the group is the name of the mentioned company. The at sign is a separator too, testimonial
 * landing pages sign investors exactly that way.
 */
const ROLE_MENTIONS_COMPANY = /(?:\bof\b|\bat\b|,|@)\s*([A-Z][\w.&-]{2,})/g;

/**
 * The word after "of" is far from always a company. "Head of Engineering", "VP of Operations",
 * "Director of Product" are departments, that is, the company's own people, yet the rule read
 * them as a foreign firm and threw them away. Enrichment silently dropped exactly the titles it
 * was written for: section 9 of CLAUDE.md asks for Head of Engineering specifically.
 */
const NOT_A_COMPANY =
  /^(engineering|operations|product|design|technology|technologies|development|delivery|people|marketing|sales|growth|data|platform|talent|partnerships|business|digital|strategy|innovation|quality|security|research|support|success|staff|department|team|projects?|accounts?|customer|client|content|brand|creative|communications|ux|ui|it|ai|qa|hr|pmo|ceo|cto|coo|cpo|cio|cmo|vp|director|founder|board|the)$/i;

/** Words after which a line is certainly not a person's name. */
const NOT_A_NAME =
  /(\d|@|http|\.com|\.net|\.org|cookie|policy|privacy|terms|reading time|read more|all rights|copyright|ltd|llc|inc\b|gmbh|solutions|agency|studio|software|digital|group|technolog|first name|last name|full name|marketplace|catalog|assets|status|changelog|pricing|docs|sign in|log in|get started|contact us|learn more|our team|the team)/i;

const NAME_SHAPE = /^[A-ZА-ЯІЇЄҐ][\p{L}'’-]{1,20}(?: [A-ZА-ЯІЇЄҐ][\p{L}'’-]{1,20}){1,2}$/u;

/** Generic mailboxes. They are needed too, but as a fallback, not as a person's contact. */
const GENERIC_MAILBOX =
  /^(hello|info|contact|office|sales|hi|team|mail|admin|support|inquiries|enquiries|hr|jobs|career|careers|welcome|business|marketing|pr|press)@/i;

/*
 * Per-company caps. A real studio team is a handful of people on the page. Thirty found means
 * the parser caught the wrong block, and storing that does harm: the owner opens the card and
 * cannot see who to actually write to.
 */
const MAX_PEOPLE = 12;
const MAX_GENERIC = 4;

export interface FoundContact {
  name: string | null;
  role: string | null;
  email: string | null;
  linkedin: string | null;
  xHandle: string | null;
  sourceUrl: string;
}

export interface SiteSignals {
  /** Year in the footer copyright. This is where a dead site shows. */
  copyrightYear: number | null;
  hasBlog: boolean;
  /** The most recent date found on a blog or news page. */
  lastPostAt: number | null;
  techHints: string[];
}

/** HTML into lines of visible text. Scripts and styles are dropped, tags become line breaks. */
export function toLines(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ');

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function looksLikeName(line: string): boolean {
  if (line.length < 4 || line.length > 44) return false;
  if (NOT_A_NAME.test(line)) return false;
  return NAME_SHAPE.test(line);
}

/**
 * A single capitalised word: "Pavel", "Alex".
 *
 * Half of modern studio sites sign a team card with the first name only, and the "a name is
 * two words" rule skipped such pages entirely: a pass over 100 studios gave zero contacts from
 * 267 downloaded pages.
 *
 * The rule is deliberately narrower than the main one: such a name is accepted only right next
 * to a title and only on a team page, otherwise button labels and menu items would end up as
 * contacts.
 */
const NOT_A_SINGLE_NAME =
  /^(home|about|team|contact|careers?|blog|news|services?|portfolio|works?|clients?|projects?|more|menu|next|back|prev|search|login|email|phone|address|company|people|culture|values|mission|vision|history|awards|partners|process|approach|hello|hi|ua|en|ru|pl|de)$/i;

const SINGLE_NAME_SHAPE = /^[A-ZА-ЯІЇЄҐ][\p{L}'’-]{2,19}$/u;

function looksLikeSingleName(line: string): boolean {
  if (NOT_A_SINGLE_NAME.test(line)) return false;
  if (NOT_A_NAME.test(line)) return false;
  // A title can also be one capitalised word ("CEO", "Designer"), and it is not a name.
  if (ROLE_ACRONYM.test(line) || ROLE_PHRASE.test(line)) return false;
  return SINGLE_NAME_SHAPE.test(line);
}

function cleanRole(line: string): string {
  return line
    .replace(/\s+at\s+.*/i, '')
    .replace(/[|•·,]+\s*$/, '')
    .trim()
    .slice(0, 60);
}

/**
 * Names are found starting from the role, not the other way round. A role is a short and
 * recognisable line with the name next to it: layouts put it before or after the role, so the
 * closest name-like line within a window of two positions is taken.
 */
/**
 * Whether a title mentions another company. "CTO at TRIARE" on triare.net is one of their own,
 * while "Founder and CEO of Sentry" on the same site is a testimonial or an investor. The
 * company's own name comes from the page address, so no extra arguments are needed.
 */
function mentionsOtherCompany(role: string, ownName: string): boolean {
  /*
   * Every mention in the line is checked, not just the first. "Former CEO of GitHub" has two:
   * "Former" and "GitHub", and one foreign mention is enough for the line to be a testimonial
   * rather than a team member. Only the first used to be taken, and word order decided the outcome.
   */
  for (const match of role.matchAll(ROLE_MENTIONS_COMPANY)) {
    const raw = match[1]!;
    if (NOT_A_COMPANY.test(raw)) continue;

    const mentioned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mentioned) continue;
    if (!ownName) return true;
    if (!mentioned.includes(ownName) && !ownName.includes(mentioned)) return true;
  }

  return false;
}

/** The second-level domain name: triare.net is "triare", www.acme.co.uk is "acme". */
function ownNameFromUrl(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return host.split('.')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch {
    return '';
  }
}

export function extractPeople(html: string, sourceUrl: string): FoundContact[] {
  return peopleFromLines(toLines(html), sourceUrl);
}

/**
 * The same parsing, but starting from ready lines of text.
 *
 * The extension needs it: it reads a rendered page in the owner's browser, where there is no
 * HTML as such but there is a DOM, and hands over exactly the same flat list of lines that
 * `toLines` builds here. So a page the server could not open is parsed by the same code and the
 * same rules, not by a second copy of the regexes that quietly drifts away in a month.
 */
export function peopleFromLines(lines: string[], sourceUrl: string): FoundContact[] {
  const ownName = ownNameFromUrl(sourceUrl);
  const found = new Map<string, FoundContact>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length > 60) continue;
    if (!ROLE_ACRONYM.test(line) && !ROLE_PHRASE.test(line)) continue;
    if (FOREIGN_ROLE.test(line)) continue;
    if (mentionsOtherCompany(line, ownName)) continue;

    let name: string | null = null;
    for (let step = 1; step <= 2 && !name; step += 1) {
      for (const candidate of [lines[index - step], lines[index + step]]) {
        if (candidate && looksLikeName(candidate)) {
          name = candidate;
          break;
        }
      }
    }

    // A first name alone is accepted only right next to a title: one word looks too much
    // like a menu item to search for it a line away.
    if (!name) {
      for (const candidate of [lines[index - 1], lines[index + 1]]) {
        if (candidate && looksLikeSingleName(candidate)) {
          name = candidate;
          break;
        }
      }
    }

    if (!name) continue;
    const role = cleanRole(line);
    if (found.has(name)) continue;
    found.set(name, { name, role, email: null, linkedin: null, xHandle: null, sourceUrl });
  }

  return [...found.values()];
}

/**
 * HTML entities back into characters. Emails are regularly written this way to keep robots from
 * harvesting them: `&#104;&#101;&#108;...` or at least `&#64;` instead of the at sign.
 */
export function decodeEntities(html: string): string {
  return html
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Decoding Cloudflare Email Protection.
 *
 * Cloudflare replaces the address with `<a href="/cdn-cgi/l/email-protection#1a2b3c">` or
 * `<span data-cfemail="1a2b3c">`, and assembles the real text with script in the browser.
 * After that the HTML has no address at all, which is why an email visible on the site was not
 * found. The scheme is simple: the first byte is the key, the remaining bytes are XORed with it.
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out.includes('@') ? out : null;
}

/**
 * Unmasking hand-made tricks: "hello (at) studio dot com" and the like. Such spellings exist to
 * keep robots from taking the address, but a person reads it, so the radar has to as well,
 * including the Ukrainian "собака" and "крапка" used on Ukrainian sites.
 */
export function unmaskEmails(text: string): string {
  return text
    .replace(/\s*[([{<]?\s*(?:at|@|＠|собака)\s*[)\]}>]?\s*/gi, (match) =>
      /@|＠|\bat\b|собака/i.test(match) ? '@' : match,
    )
    .replace(/\s*[([{<]?\s*(?:dot|крапка)\s*[)\]}>]?\s*/gi, '.');
}

export function extractEmails(html: string): { email: string; generic: boolean }[] {
  const seen = new Set<string>();
  const result: { email: string; generic: boolean }[] = [];

  const add = (raw: string) => {
    const email = raw.toLowerCase().trim().replace(/^mailto:/, '');
    // Tails like .png appear when an address got glued to a file name.
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
    if (/^(example|test|your|name|email|user|domain|sentry|wordpress)@/.test(email)) return;
    if (seen.has(email)) return;
    seen.add(email);
    result.push({ email, generic: GENERIC_MAILBOX.test(email) });
  };

  const decoded = decodeEntities(html);

  // Cloudflare goes first: after it an address appears where there was none at all.
  for (const match of decoded.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) {
    const email = decodeCfEmail(match[1]!);
    if (email) add(email);
  }
  for (const match of decoded.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const email = decodeCfEmail(match[1]!);
    if (email) add(email);
  }

  for (const match of decoded.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try {
      add(decodeURIComponent(match[1]!));
    } catch {
      // Broken percent-encoding is no reason to fail parsing the whole page.
    }
  }

  const plain = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  for (const match of decoded.matchAll(plain)) add(match[0]);

  /*
   * The same search over the visible text rather than the markup. An address is often split by
   * tags: `<span>hello</span>@<span>studio.com</span>`, and in raw HTML it matches no pattern,
   * while in the page text it does.
   */
  const text = unmaskEmails(
    cheerio.load(decoded)('body').text().replace(/\s*\n\s*/g, ' '),
  );
  for (const match of text.matchAll(plain)) add(match[0]);

  return result;
}

export function extractProfiles(html: string): { linkedin: string[]; x: string[] } {
  const linkedin = [
    ...new Set(
      [...html.matchAll(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9._%-]+/gi)].map(
        (match) => match[0],
      ),
    ),
  ];
  const x = [
    ...new Set(
      [...html.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})\b/gi)]
        .map((match) => match[1]!)
        .filter((handle) => !/^(share|intent|home|i|hashtag)$/i.test(handle)),
    ),
  ];
  return { linkedin, x };
}

/**
 * Signs of life. An agency with a 2019 copyright and no recent posts is unlikely to be hiring,
 * and a letter there is a wasted evening.
 */
export function extractSignals(html: string): SiteSignals {
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/gi)].map((match) =>
    Number(match[1]),
  );
  const isoDates = [...html.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map((match) =>
    Date.parse(`${match[1]}-${match[2]}-${match[3]}`),
  );

  return {
    copyrightYear: years.length > 0 ? Math.max(...years) : null,
    hasBlog: /href="[^"]*\/(blog|news|insights|articles)\b/i.test(html),
    lastPostAt: isoDates.length > 0 ? Math.max(...isoDates.filter(Number.isFinite)) : null,
    // Markup and text together: the first tells what the site is built on, the second what they can do.
    techHints: detectStack(html),
  };
}

/**
 * Whether an address looks like a team page. People are collected only from such pages: the
 * home page carries client testimonials and investor logos, and each such block looks to the
 * parser exactly like an employee card.
 */
export function isTeamPage(url: string): boolean {
  return /\/(team|about|people|company|leadership|contacts?|about-us|our-team|contact-us)\b/i.test(url);
}

/** Links to team pages from the home page, plus guessed paths. */
export function findTeamLinks(html: string, base: string): string[] {
  const urls = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]+>/g, ' ');
    if (!TEAM_TEXT.test(href) && !TEAM_TEXT.test(text)) continue;
    try {
      const url = new URL(href, base);
      if (url.hostname === new URL(base).hostname) urls.add(url.href);
    } catch {
      // A broken link is no reason to fail the whole crawl.
    }
  }

  return [...urls];
}

/**
 * Script URLs on the same domain. Needed for sites that render in the browser: the HTML has an
 * empty `<div id="root">`, and the email sits in the bundle that fills that div. Fetching it is
 * expensive, so this is the last step and only when the markup had no address at all.
 */
export function findScripts(html: string, base: string): string[] {
  const host = new URL(base).hostname;
  const urls: string[] = [];

  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    try {
      const url = new URL(match[1]!, base);
      if (url.hostname !== host) continue;
      if (!/\.m?js(\?|$)/i.test(url.pathname)) continue;
      urls.push(url.href);
    } catch {
      // A broken src is no reason to fail the crawl.
    }
  }

  /*
   * Main bundles first: they hold the page shell with the footer and contacts.
   * Small chunks are usually separate routes with no address in them.
   */
  const weight = (url: string) => (/(main|index|app|bundle|entry)/i.test(url) ? 0 : 1);
  return [...new Set(urls)].sort((a, b) => weight(a) - weight(b));
}

/** How much text is visible without scripts. An empty page means rendering in the browser. */
export function visibleTextLength(html: string): number {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().length;
}

export interface EnrichResult {
  companyId: number;
  domain: string;
  contacts: FoundContact[];
  signals: SiteSignals | null;
  pagesFetched: number;
  /** The site renders its content with script: the HTML has almost no text. Explains an empty result. */
  clientRendered: boolean;
  /**
   * The home page did not open for the server at all: timeout, 403 from protection, dead domain.
   * That is not the same as "found nothing", and it needs different handling.
   */
  reachable: boolean;
}

/**
 * Crawl one company site. The page limit is deliberately small: value drops quickly, and
 * `fetchText` keeps a per-domain pause, so every extra page is a second of the run.
 */
export async function enrichCompany(
  company: Company,
  maxPages = 5,
  maxServicePages = 2,
  maxScripts = 2,
): Promise<EnrichResult> {
  const base = `https://${company.domain}`;
  const result: EnrichResult = {
    companyId: company.id,
    domain: company.domain,
    contacts: [],
    signals: null,
    pagesFetched: 0,
    clientRendered: false,
    reachable: false,
  };

  let homepage = '';
  try {
    const res = await fetchText(base);
    homepage = res.body;
    result.pagesFetched += 1;
    result.reachable = true;
    result.signals = extractSignals(homepage);
    // Two hundred characters is less than one paragraph: such HTML is a shell, not a page.
    result.clientRendered = visibleTextLength(homepage) < 200;
  } catch (error) {
    log.warn({ domain: company.domain, err: String(error) }, 'home page did not open, enrichment skipped');
    return result;
  }

  const byName = new Map<string, FoundContact>();
  const emails: { email: string; generic: boolean; sourceUrl: string }[] = [];

  const harvest = (html: string, url: string) => {
    /*
     * The stack is collected from every opened page, not only the home page. The home page often
     * has a slogan and three pictures, while the technology list lives on the services page, and
     * that list shows whether writing to this studio makes sense.
     */
    if (result.signals) {
      result.signals.techHints = [...new Set([...result.signals.techHints, ...detectStack(html)])];
    }

    if (isTeamPage(url)) {
      for (const person of extractPeople(html, url)) {
        if (!byName.has(person.name!)) byName.set(person.name!, person);
      }
    }
    for (const item of extractEmails(html)) emails.push({ ...item, sourceUrl: url });
  };

  // From the home page only email and signs of life are taken, not people.
  harvest(homepage, base);

  const candidates = [
    ...findTeamLinks(homepage, base),
    ...TEAM_PATHS.map((path) => `${base}${path}`),
  ];

  // Service pages get their own small budget so they do not eat the budget for people.
  const servicePages = SERVICE_PATHS.map((path) => `${base}${path}`);

  for (const url of [...new Set([...candidates.slice(0, maxPages), ...servicePages.slice(0, maxServicePages)])]) {
    if (url === base) continue;
    try {
      const res = await fetchText(url);
      result.pagesFetched += 1;
      harvest(res.body, url);
    } catch {
      // A 404 on a guessed path is a normal outcome.
    }
  }

  /*
   * Still no address. The most common cause is a site on React or another client-side engine:
   * the markup is empty, and the footer with the email is assembled by script in the browser.
   * Then the bundles themselves are read, the address sits in them as a string.
   */
  if (emails.length === 0) {
    for (const url of findScripts(homepage, base).slice(0, maxScripts)) {
      try {
        const res = await fetchText(url);
        result.pagesFetched += 1;
        for (const item of extractEmails(res.body)) emails.push({ ...item, sourceUrl: url });
        if (emails.length > 0) break;
      } catch {
        // A bundle may have moved or be too large, no reason to fail the crawl.
      }
    }
  }

  const profiles = extractProfiles(homepage);

  // Named contacts go first, generic mailboxes as separate records with the general role.
  const people = [...byName.values()];
  for (const [index, person] of people.entries()) {
    person.linkedin = profiles.linkedin[index] ?? null;
  }

  const uniqueEmails = [...new Map(emails.map((item) => [item.email, item])).values()];
  const namedEmails = uniqueEmails.filter((item) => !item.generic);
  const genericEmails = uniqueEmails.filter((item) => item.generic);

  /*
   * A personal address is tied to a person only when the local part really matches the name.
   * Otherwise a random person's email would end up attributed to the director.
   */
  for (const person of people) {
    const parts = person.name!.toLowerCase().split(' ');
    const match = namedEmails.find((item) =>
      parts.some((part) => part.length > 2 && item.email.split('@')[0]!.includes(part)),
    );
    if (match) person.email = match.email;
  }

  result.contacts = [
    ...people.slice(0, MAX_PEOPLE),
    ...genericEmails.slice(0, MAX_GENERIC).map((item) => ({
      name: null,
      role: 'general',
      email: item.email,
      linkedin: null,
      xHandle: profiles.x[0] ?? null,
      sourceUrl: item.sourceUrl,
    })),
  ];

  return result;
}

/** Store what was found. Existing contacts are not duplicated but completed. */
export async function saveEnrichment(result: EnrichResult): Promise<{ added: number }> {
  const db = getDb();
  const existing = await db.select().from(contacts).where(eq(contacts.companyId, result.companyId));
  const known = new Set(existing.map((row) => `${row.name ?? ''}|${row.email ?? ''}`));

  const fresh = result.contacts.filter((item) => !known.has(`${item.name ?? ''}|${item.email ?? ''}`));

  if (fresh.length > 0) {
    await db.insert(contacts).values(
      fresh.map((item) => ({
        companyId: result.companyId,
        name: item.name,
        role: item.role,
        email: item.email,
        linkedin: item.linkedin,
        xHandle: item.xHandle,
        sourceUrl: item.sourceUrl,
      })),
    );
  }

  const hasEmail = result.contacts.some((item) => item.email);

  /*
   * The timestamp is always set, even when the site did not open at all.
   *
   * It used to be written only on success, and a company with a dead or blocked home page kept an
   * empty `last_checked`, which made it forever first in line: every next batch took exactly that
   * company and hit the same wall again.
   */
  const patch: Record<string, unknown> = { lastChecked: Date.now() };

  /*
   * Two different cases, one queue: the page has to be opened by a browser.
   *
   * The first, the site is rendered by script, and the raw HTML has nothing. The second, the
   * home page was not served to the server at all: protection answered 403 to a request without
   * a real browser. In the owner's browser both open fine, so both go to the extension queue
   * rather than nowhere.
   */
  patch.needsBrowser = !hasEmail && (result.clientRendered || !result.reachable);

  if (result.signals) {
    // Signs of life are stored, not just computed: scoring relies on them.
    if (result.signals.copyrightYear) patch.copyrightYear = result.signals.copyrightYear;
    if (result.signals.lastPostAt) patch.lastPostAt = result.signals.lastPostAt;

    if (result.signals.techHints.length > 0) {
      const company = await db
        .select({ techHints: companies.techHints })
        .from(companies)
        .where(eq(companies.id, result.companyId));
      patch.techHints = [...new Set([...(company[0]?.techHints ?? []), ...result.signals.techHints])];
    }
  }

  await db.update(companies).set(patch).where(eq(companies.id, result.companyId));

  return { added: fresh.length };
}

export interface EnrichOptions {
  limit?: number;
  domain?: string;
  /** Take everyone, not only those without contacts yet. */
  all?: boolean;
}

export async function candidatesForEnrichment(options: EnrichOptions = {}): Promise<Company[]> {
  const db = getDb();

  if (options.domain) {
    return db.select().from(companies).where(eq(companies.domain, options.domain));
  }

  const withContacts = db.select({ id: contacts.companyId }).from(contacts);

  /*
   * The order matters more than it seems. Without it the first table rows were taken, and those
   * are Vercel, Anthropic and Stripe: product giants have no team page with names and emails, so
   * a pass over 120 companies gave exactly zero contacts and looked like broken enrichment. In
   * fact it was looking in the wrong place.
   *
   * So first come those the owner actually writes cold letters to: studios, design agencies and
   * startups. Product companies go last, and a company with a catalog profile goes ahead of one
   * that only came from an ATS: a catalog almost always means a real agency.
   */
  const priority = sql`case ${companies.kind}
      when 'studio' then 0
      when 'design' then 0
      when 'startup' then 1
      when 'outstaff' then 2
      when 'product' then 4
      else 3
    end`;

  const rows = await db
    .select()
    .from(companies)
    .where(
      options.all
        ? sql`${companies.domain} <> ''`
        : and(sql`${companies.domain} <> ''`, sql`${companies.id} not in ${withContacts}`),
    )
    /*
     * The last criterion is the time of last touch, oldest first. A company whose site did not
     * open stays without contacts, and without this it would sit at the head of the queue
     * forever: every next batch would take the same twenty.
     */
    .orderBy(
      priority,
      sql`case when ${companies.sourceUrl} is null then 1 else 0 end`,
      sql`coalesce(${companies.lastChecked}, 0)`,
      companies.id,
    )
    .limit(options.limit ?? 25);

  return rows;
}

/** How many companies still await contact collection. The interface stops the pass by this number. */
export async function pendingEnrichment(options: EnrichOptions = {}): Promise<number> {
  const db = getDb();
  const withContacts = db.selectDistinct({ id: contacts.companyId }).from(contacts);

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(companies)
    .where(
      options.all
        ? sql`${companies.domain} <> ''`
        : and(sql`${companies.domain} <> ''`, sql`${companies.id} not in ${withContacts}`),
    );

  return row?.count ?? 0;
}

/** `itemsFound` and `itemsNew` are needed by the `withRun` wrapper, the other fields are for the report. */
export interface EnrichStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  checked: number;
  withPeople: number;
  withEmail: number;
  contactsAdded: number;
  pagesFetched: number;
  /** How many companies are left after this batch. Zero means collection is done. */
  remaining: number;
  /** Sites that render content with script. Explains an empty result instead of hiding it. */
  clientRendered: number;
  /** Sites that did not open for the server at all: timeout, 403 from protection, dead domain. */
  unreachable: number;
}

export async function enrich(options: EnrichOptions = {}): Promise<EnrichStats> {
  return withRun('enrich', async () => {
    const targets = await candidatesForEnrichment(options);
    const pending = await pendingEnrichment(options);
    const stats: EnrichStats = {
      itemsFound: targets.length,
      itemsNew: 0,
      errors: [],
      checked: 0,
      withPeople: 0,
      withEmail: 0,
      contactsAdded: 0,
      pagesFetched: 0,
      clientRendered: 0,
      unreachable: 0,
      remaining: Math.max(0, pending - targets.length),
    };

    for (const company of targets) {
      try {
        const result = await enrichCompany(company);
        stats.checked += 1;
        stats.pagesFetched += result.pagesFetched;
        if (result.clientRendered) stats.clientRendered += 1;
        if (!result.reachable) stats.unreachable += 1;

        const people = result.contacts.filter((item) => item.name);
        if (people.length > 0) stats.withPeople += 1;
        if (result.contacts.some((item) => item.email)) stats.withEmail += 1;

        const saved = await saveEnrichment(result);
        stats.contactsAdded += saved.added;
        stats.itemsNew += saved.added;
      } catch (error) {
        // One unreachable site must not fail the pass over the other hundred.
        stats.errors.push(`${company.domain}: ${error instanceof Error ? error.message : String(error)}`);
        // Timestamp even on failure, otherwise this company is forever first in line.
        await getDb()
          .update(companies)
          .set({ lastChecked: Date.now() })
          .where(eq(companies.id, company.id));
      }
    }

    /*
     * Rule 3 of CLAUDE.md: an empty result is an error, not a success. A pass over a hundred
     * domains without a single contact means either a broken parser or looking in the wrong
     * companies. Staying silent is not allowed, otherwise the next pass burns out the same way.
     */
    if (stats.checked >= 10 && stats.contactsAdded === 0) {
      const message = `checked ${stats.checked} domains and found no contacts at all`;
      stats.errors.push(message);
      log.warn(stats, message);
    } else {
      log.info(stats, 'enrichment finished');
    }

    return stats;
  });
}

/**
 * The extension queue: domains the server-side crawl got nothing from because the page is
 * rendered by script. The extension opens them in the owner's own browser, reads the finished
 * DOM and sends what it found back here.
 *
 * The limit is small on purpose: this is a pass over other people's sites in a real browser,
 * with pauses, the way a person browses. Section 4 of CLAUDE.md.
 */
export interface BrowserTarget {
  companyId: number;
  name: string;
  domain: string;
}

export async function browserQueue(limit = 20): Promise<BrowserTarget[]> {
  const db = getDb();
  const withEmail = db
    .selectDistinct({ id: contacts.companyId })
    .from(contacts)
    .where(sql`${contacts.email} is not null`);

  const rows = await db
    .select({ companyId: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.needsBrowser, true), sql`${companies.id} not in ${withEmail}`))
    .orderBy(sql`coalesce(${companies.lastChecked}, 0)`)
    .limit(Math.min(limit, 50));

  return rows;
}

export interface BrowserPage {
  url: string;
  /** The flat page text by line, in the same shape `toLines` produces. */
  lines: string[];
}

export interface BrowserFindings {
  companyId?: number | null;
  domain: string;
  emails?: { email: string; name?: string | null; role?: string | null }[];
  techHints?: string[];
  copyrightYear?: number | null;
  lastPostAt?: number | null;
  /** Pages the extension managed to read: the home page and what it linked to. */
  pages?: BrowserPage[];
}

export interface BrowserSaveResult {
  companyId: number | null;
  contactsAdded: number;
  techAdded: number;
  /** How many pages came in, and how many addresses and people came out of them. */
  pagesRead: number;
  emailsFound: number;
  peopleFound: number;
}

/**
 * Whether this address belongs to this person. `anna@` and `a.koval@` are Anna Koval, while
 * `hello@` belongs to nobody. Needed so the contact is stored as one row with name, role and
 * email rather than two halves nobody can write a letter from.
 */
export function emailBelongsTo(email: string, name: string): boolean {
  const local = email.split('@')[0]!.toLowerCase();
  if (GENERIC_MAILBOX.test(email)) return false;

  const parts = name
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((part) => part.length >= 3);
  if (parts.length === 0) return false;

  // A whole word, otherwise "ann" in "announcements@" would match as a substring.
  const tokens = local.split(/[^a-z]+/).filter(Boolean);
  return parts.some((part) => tokens.includes(part) || (tokens.length === 1 && tokens[0] === parts.join('')));
}

/**
 * Accept what the extension read from a rendered page.
 *
 * The `needs_browser` flag is cleared in any case, even when nothing was found: the page has
 * already been opened in a browser, and sending it there again every time would mean an endless
 * queue of the same domains.
 */
export async function saveBrowserFindings(input: BrowserFindings): Promise<BrowserSaveResult> {
  const db = getDb();
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error(`invalid domain: ${input.domain}`);

  /*
   * By domain first, and if there is none, by the company id the queue provided.
   *
   * The domain comes from the tab address after redirects, and that is enough to miss: a studio
   * moved from `agency.io` to `agency.com`, the tab shows the new address, the database has the
   * old one. The lookup used to find nothing in that case and the function silently returned zero:
   * the site opened, the email was found, and it got lost on the way. The company id was in the
   * request, nobody used it.
   */
  const [byDomain] = await db.select().from(companies).where(eq(companies.domain, domain));
  const [company] = byDomain
    ? [byDomain]
    : input.companyId
      ? await db.select().from(companies).where(eq(companies.id, input.companyId))
      : [];

  const empty = { companyId: null, contactsAdded: 0, techAdded: 0, pagesRead: 0, emailsFound: 0, peopleFound: 0 };
  if (!company) {
    log.warn({ domain, companyId: input.companyId }, 'nowhere to store browser data: no such company');
    return empty;
  }

  const pages = input.pages ?? [];

  /*
   * People are parsed by the same code as on pages the server downloaded itself. A team page
   * gives a name and a title, a contact page gives an address, and they have to meet in one
   * contact right here, before writing.
   */
  const people = new Map<string, FoundContact>();
  for (const page of pages) {
    for (const person of peopleFromLines(page.lines ?? [], page.url)) {
      if (!people.has(person.name!)) people.set(person.name!, person);
    }
  }

  const emails = (input.emails ?? []).slice(0, MAX_GENERIC + MAX_PEOPLE);

  for (const item of emails) {
    const email = normalizeEmail(item.email);
    if (!email) continue;
    const owner = [...people.values()].find(
      (person) => person.name && !person.email && emailBelongsTo(email, person.name),
    );
    if (owner) owner.email = email;
  }

  let contactsAdded = 0;

  /*
   * Named contacts first, and only they may carry a name and address pair into the database. A
   * person without an email is stored too: knowing that a specific Anna is the CTO is enough to
   * look for the address deliberately later.
   */
  const existing = await db.select().from(contacts).where(eq(contacts.companyId, company.id));
  const known = new Set(existing.map((row) => `${row.name ?? ''}|${row.email ?? ''}`));

  for (const person of people.values()) {
    if (!person.name) continue;

    if (person.email) {
      const { created } = await rememberContact(company.id, person.email, person.name, person.role);
      if (created) contactsAdded += 1;
      continue;
    }

    // Without an email `rememberContact` does not work: it looks up the existing record by it.
    if (known.has(`${person.name}|`)) continue;
    known.add(`${person.name}|`);
    await db.insert(contacts).values({
      companyId: company.id,
      name: person.name,
      role: person.role,
      sourceUrl: person.sourceUrl,
    });
    contactsAdded += 1;
  }

  const claimed = new Set([...people.values()].map((person) => person.email).filter(Boolean));

  for (const item of emails) {
    const email = normalizeEmail(item.email);
    if (!email || claimed.has(email)) continue;
    const { created } = await rememberContact(company.id, email, item.name ?? null, item.role ?? null);
    if (created) contactsAdded += 1;
  }

  const techHints = [...new Set([...company.techHints, ...(input.techHints ?? [])])];
  const patch: Record<string, unknown> = {
    needsBrowser: false,
    lastChecked: Date.now(),
    techHints,
  };
  if (input.copyrightYear) patch.copyrightYear = input.copyrightYear;
  if (input.lastPostAt) patch.lastPostAt = input.lastPostAt;

  await db.update(companies).set(patch).where(eq(companies.id, company.id));

  const result: BrowserSaveResult = {
    companyId: company.id,
    contactsAdded,
    techAdded: techHints.length - company.techHints.length,
    pagesRead: pages.length,
    emailsFound: emails.length,
    peopleFound: people.size,
  };

  /*
   * Rule 3 of CLAUDE.md: an empty result is an error, not a success. The browser just opened four
   * pages of someone's site and came back with nothing, which is either a layout the parser does
   * not handle or a domain that really has nothing. Staying silent is not allowed: that is exactly
   * how collection looked like it worked while collecting nothing.
   */
  if (emails.length === 0 && people.size === 0) {
    log.warn(result, 'the browser read the pages and found neither emails nor people');
  } else {
    log.info(result, 'browser data saved');
  }

  return result;
}
