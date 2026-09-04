import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, contacts, type Company } from '../db/schema.js';
import { fetchText } from '../lib/http.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { detectTech } from './discover.js';

/**
 * Збір контактів і ознак живості з сайту компанії.
 *
 * Навіщо: у базі сотні студій, і майже в кожної в картці написано "іменних контактів
 * немає". Список без адреси нікуди не веде, а лист на hello@ читає менеджер, не техлід.
 *
 * Модель тут не викликається взагалі, і це свідомо: розбір іменних контактів з HTML
 * робиться регулярками по сплощеному тексту, тому прохід по всій базі коштує нуль.
 * Правило з CLAUDE.md розділ 9 описує саме такий збір.
 */

/** Сторінки, де живуть команда і контакти. Порядок від найціннішого до найзагальнішого. */
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

/** Посилання в меню, які ведуть на ті самі сторінки під іншими адресами. */
const TEAM_TEXT = /(team|about|people|leadership|contact|команда|про нас|контакт)/i;

/*
 * Акроніми ловляться тільки у верхньому регістрі і з межами слова. Без цього "coo"
 * знаходився всередині "cookie" і давав по 130 фальшивих збігів на сторінку,
 * бо cookie-банер є всюди.
 */
const ROLE_ACRONYM = /\b(?:CTO|CEO|COO|CPO|CIO|CMO|VP)\b/;
const ROLE_PHRASE =
  /\b(?:co-?founder|founder|tech(?:nical)? lead|team lead|head of [a-z/& ]{2,24}|engineering manager|lead (?:developer|engineer)|managing director|delivery manager)\b/i;

/*
 * Роль чужої компанії означає інвестора або відгук, а не людину з цієї команди.
 * На лендінгах продуктових компаній таких блоків десятки: "Nat Friedman, Former CEO
 * of GitHub". Перший прогін по десяти компаніях приніс 104 контакти, з них більшість
 * була саме звідти.
 */
const FOREIGN_ROLE = /\b(?:former|ex-|previously|investor|advisor|board member)\b/i;

/**
 * "CEO of Sentry", "Head of Engineering, Ramp", "Co-Founder @ FPV Ventures":
 * група це назва згаданої компанії. Собака теж роздільник, на лендінгах з відгуками
 * саме через неї підписані інвестори.
 */
const ROLE_MENTIONS_COMPANY = /(?:\bof\b|\bat\b|,|@)\s*([A-Z][\w.&-]{2,})/;

/** Слова, після яких рядок точно не імʼя людини. */
const NOT_A_NAME =
  /(\d|@|http|\.com|\.net|\.org|cookie|policy|privacy|terms|reading time|read more|all rights|copyright|ltd|llc|inc\b|gmbh|solutions|agency|studio|software|digital|group|technolog|first name|last name|full name|marketplace|catalog|assets|status|changelog|pricing|docs|sign in|log in|get started|contact us|learn more|our team|the team)/i;

const NAME_SHAPE = /^[A-ZА-ЯІЇЄҐ][\p{L}'’-]{1,20}(?: [A-ZА-ЯІЇЄҐ][\p{L}'’-]{1,20}){1,2}$/u;

/** Загальні скриньки. Вони теж потрібні, але як запасний варіант, не як контакт людини. */
const GENERIC_MAILBOX =
  /^(hello|info|contact|office|sales|hi|team|mail|admin|support|inquiries|enquiries|hr|jobs|career|careers|welcome|business|marketing|pr|press)@/i;

/*
 * Стелі на компанію. Реальна команда студії це одиниці людей на сторінці. Тридцять
 * знайдених означає, що розбір зачепив не той блок, і зберігати це шкідливо:
 * власник відкриє картку і не побачить, кому насправді писати.
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
  /** Рік у копірайті футера. Мертвий сайт видно саме тут. */
  copyrightYear: number | null;
  hasBlog: boolean;
  /** Найсвіжіша дата, знайдена на сторінці блогу або новин. */
  lastPostAt: number | null;
  techHints: string[];
}

/** HTML у рядки видимого тексту. Скрипти і стилі викидаються, теги стають переносами. */
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

function cleanRole(line: string): string {
  return line
    .replace(/\s+at\s+.*/i, '')
    .replace(/[|•·,]+\s*$/, '')
    .trim()
    .slice(0, 60);
}

/**
 * Імена шукаються від ролі, а не навпаки. Роль це короткий і впізнаваний рядок,
 * а імʼя поруч із ним: у різних версток воно стоїть то перед роллю, то після,
 * тому береться найближчий рядок, схожий на імʼя, з вікна в дві позиції.
 */
/**
 * Чи згадана в посаді чужа компанія. "CTO at TRIARE" на сайті triare.net це своя
 * людина, а "Founder and CEO of Sentry" на тому самому сайті це відгук або інвестор.
 * Назва своєї компанії береться з адреси сторінки, тому додаткових аргументів не треба.
 */
function mentionsOtherCompany(role: string, ownName: string): boolean {
  const match = ROLE_MENTIONS_COMPANY.exec(role);
  if (!match) return false;
  const mentioned = match[1]!.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!mentioned || !ownName) return true;
  return !mentioned.includes(ownName) && !ownName.includes(mentioned);
}

/** Друге ім'я домену: triare.net це "triare", а www.acme.co.uk це "acme". */
function ownNameFromUrl(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return host.split('.')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch {
    return '';
  }
}

export function extractPeople(html: string, sourceUrl: string): FoundContact[] {
  const ownName = ownNameFromUrl(sourceUrl);
  const lines = toLines(html);
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

    if (!name) continue;
    const role = cleanRole(line);
    if (found.has(name)) continue;
    found.set(name, { name, role, email: null, linkedin: null, xHandle: null, sourceUrl });
  }

  return [...found.values()];
}

export function extractEmails(html: string): { email: string; generic: boolean }[] {
  const seen = new Set<string>();
  const result: { email: string; generic: boolean }[] = [];

  const add = (raw: string) => {
    const email = raw.toLowerCase().trim();
    // Хвости на кшталт .png трапляються, коли адреса склеїлась з іменем файла.
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
    if (/^(example|test|your|name|email|user)@/.test(email)) return;
    if (seen.has(email)) return;
    seen.add(email);
    result.push({ email, generic: GENERIC_MAILBOX.test(email) });
  };

  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) add(decodeURIComponent(match[1]!));
  for (const match of html.matchAll(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g)) add(match[0]);

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
 * Ознаки живості. Агенція з копірайтом 2019 року і без свіжих постів навряд чи
 * наймає, і лист туди це витрачений вечір.
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
    techHints: detectTech(html),
  };
}

/**
 * Чи схожа адреса на сторінку команди. Люди збираються тільки з таких сторінок:
 * на головній стоять відгуки клієнтів і логотипи інвесторів, і кожен такий блок
 * виглядає для розбору точно як картка співробітника.
 */
export function isTeamPage(url: string): boolean {
  return /\/(team|about|people|company|leadership|contacts?|about-us|our-team|contact-us)\b/i.test(url);
}

/** Посилання на сторінки команди з головної, плюс вгадані шляхи. */
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
      // Побите посилання це не привід валити весь обхід.
    }
  }

  return [...urls];
}

export interface EnrichResult {
  companyId: number;
  domain: string;
  contacts: FoundContact[];
  signals: SiteSignals | null;
  pagesFetched: number;
}

/**
 * Обійти сайт однієї компанії. Ліміт сторінок навмисно малий: цінність швидко падає,
 * а `fetchText` тримає паузу на домен, тому кожна зайва сторінка це секунда прогону.
 */
export async function enrichCompany(company: Company, maxPages = 5): Promise<EnrichResult> {
  const base = `https://${company.domain}`;
  const result: EnrichResult = {
    companyId: company.id,
    domain: company.domain,
    contacts: [],
    signals: null,
    pagesFetched: 0,
  };

  let homepage = '';
  try {
    const res = await fetchText(base);
    homepage = res.body;
    result.pagesFetched += 1;
    result.signals = extractSignals(homepage);
  } catch (error) {
    log.warn({ domain: company.domain, err: String(error) }, 'головна не відкрилась, enrichment пропущено');
    return result;
  }

  const byName = new Map<string, FoundContact>();
  const emails: { email: string; generic: boolean; sourceUrl: string }[] = [];

  const harvest = (html: string, url: string) => {
    if (isTeamPage(url)) {
      for (const person of extractPeople(html, url)) {
        if (!byName.has(person.name!)) byName.set(person.name!, person);
      }
    }
    for (const item of extractEmails(html)) emails.push({ ...item, sourceUrl: url });
  };

  // З головної беремо тільки пошту і ознаки живості, людей звідти не беремо.
  harvest(homepage, base);

  const candidates = [
    ...findTeamLinks(homepage, base),
    ...TEAM_PATHS.map((path) => `${base}${path}`),
  ];

  for (const url of [...new Set(candidates)].slice(0, maxPages)) {
    if (url === base) continue;
    try {
      const res = await fetchText(url);
      result.pagesFetched += 1;
      harvest(res.body, url);
    } catch {
      // 404 на вгаданому шляху це нормальний результат.
    }
  }

  const profiles = extractProfiles(homepage);

  // Іменні контакти йдуть першими, загальні скриньки окремими записами з роллю general.
  const people = [...byName.values()];
  for (const [index, person] of people.entries()) {
    person.linkedin = profiles.linkedin[index] ?? null;
  }

  const uniqueEmails = [...new Map(emails.map((item) => [item.email, item])).values()];
  const namedEmails = uniqueEmails.filter((item) => !item.generic);
  const genericEmails = uniqueEmails.filter((item) => item.generic);

  /*
   * Іменну адресу привʼязуємо до людини лише коли локальна частина справді збігається
   * з іменем. Інакше вийшло б, що пошта випадкової людини приписана директору.
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

/** Зберегти знайдене. Наявні контакти не дублюються, а доповнюються. */
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

  if (result.signals) {
    const patch: Record<string, unknown> = { lastChecked: Date.now() };

    // Ознаки живості зберігаються, а не тільки рахуються: на них спирається скоринг.
    if (result.signals.copyrightYear) patch.copyrightYear = result.signals.copyrightYear;
    if (result.signals.lastPostAt) patch.lastPostAt = result.signals.lastPostAt;

    if (result.signals.techHints.length > 0) {
      const company = await db
        .select({ techHints: companies.techHints })
        .from(companies)
        .where(eq(companies.id, result.companyId));
      patch.techHints = [...new Set([...(company[0]?.techHints ?? []), ...result.signals.techHints])];
    }
    await db.update(companies).set(patch).where(eq(companies.id, result.companyId));
  }

  return { added: fresh.length };
}

export interface EnrichOptions {
  limit?: number;
  domain?: string;
  /** Брати всіх підряд, а не тільки тих, у кого контактів ще немає. */
  all?: boolean;
}

export async function candidatesForEnrichment(options: EnrichOptions = {}): Promise<Company[]> {
  const db = getDb();

  if (options.domain) {
    return db.select().from(companies).where(eq(companies.domain, options.domain));
  }

  const withContacts = db.select({ id: contacts.companyId }).from(contacts);

  /*
   * Порядок тут важить більше, ніж здається. Без нього бралися просто перші рядки
   * таблиці, а це Vercel, Anthropic і Stripe: у продуктових гігантів сторінки команди
   * з іменами і поштою немає, тому прохід по 120 компаніях дав рівно нуль контактів
   * і виглядав як поламаний enrichment. Насправді він шукав не там.
   *
   * Тому спершу ті, кому власник реально пише холодні листи: студії, дизайн-агенції
   * і стартапи. Продуктові йдуть останніми, а компанія з профілем у каталозі
   * попереду тієї, що прийшла лише з ATS: у каталозі майже завжди справжня агенція.
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
    .orderBy(priority, sql`case when ${companies.sourceUrl} is null then 1 else 0 end`, companies.id)
    .limit(options.limit ?? 25);

  return rows;
}

/** `itemsFound` і `itemsNew` потрібні обгортці `withRun`, решта полів для звіту. */
export interface EnrichStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  checked: number;
  withPeople: number;
  withEmail: number;
  contactsAdded: number;
  pagesFetched: number;
}

export async function enrich(options: EnrichOptions = {}): Promise<EnrichStats> {
  return withRun('enrich', async () => {
    const targets = await candidatesForEnrichment(options);
    const stats: EnrichStats = {
      itemsFound: targets.length,
      itemsNew: 0,
      errors: [],
      checked: 0,
      withPeople: 0,
      withEmail: 0,
      contactsAdded: 0,
      pagesFetched: 0,
    };

    for (const company of targets) {
      try {
        const result = await enrichCompany(company);
        stats.checked += 1;
        stats.pagesFetched += result.pagesFetched;

        const people = result.contacts.filter((item) => item.name);
        if (people.length > 0) stats.withPeople += 1;
        if (result.contacts.some((item) => item.email)) stats.withEmail += 1;

        const saved = await saveEnrichment(result);
        stats.contactsAdded += saved.added;
        stats.itemsNew += saved.added;
      } catch (error) {
        // Один недоступний сайт не має валити прохід по решті сотні.
        stats.errors.push(`${company.domain}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /*
     * Правило 3 в CLAUDE.md: порожній результат це помилка, не успіх. Прохід по
     * сотні доменів без жодного контакту означає або зламаний парсер, або те, що
     * шукали не в тих компаніях. Мовчати про це не можна, інакше наступний прохід
     * так само згорить у нікуди.
     */
    if (stats.checked >= 10 && stats.contactsAdded === 0) {
      const message = `перевірено ${stats.checked} доменів і не знайдено жодного контакту`;
      stats.errors.push(message);
      log.warn(stats, message);
    } else {
      log.info(stats, 'enrichment завершено');
    }

    return stats;
  });
}
