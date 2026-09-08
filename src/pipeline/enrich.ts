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
/**
 * Сторінки послуг. Люди звідти не збираються, а стек збирається: студія описує там
 * словами, що вона робить клієнтам, і це часто не збігається з тим, на чому зроблений
 * її власний сайт. Контора, яка робить headless-магазини, сама може сидіти на WordPress.
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
const ROLE_MENTIONS_COMPANY = /(?:\bof\b|\bat\b|,|@)\s*([A-Z][\w.&-]{2,})/g;

/**
 * Слово після "of" далеко не завжди компанія. "Head of Engineering", "VP of Operations",
 * "Director of Product" це відділ, тобто своя людина, а правило читало їх як чужу
 * фірму і викидало. Через це enrichment мовчки відкидав рівно ті посади, заради
 * яких він і написаний: розділ 9 у CLAUDE.md просить саме Head of Engineering.
 */
const NOT_A_COMPANY =
  /^(engineering|operations|product|design|technology|technologies|development|delivery|people|marketing|sales|growth|data|platform|talent|partnerships|business|digital|strategy|innovation|quality|security|research|support|success|staff|department|team|projects?|accounts?|customer|client|content|brand|creative|communications|ux|ui|it|ai|qa|hr|pmo|ceo|cto|coo|cpo|cio|cmo|vp|director|founder|board|the)$/i;

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

/**
 * Одне слово з великої літери: "Pavel", "Alex".
 *
 * Половина сучасних сайтів студій підписує картку команди самим імʼям, без
 * прізвища, і правило "імʼя це два слова" пропускало такі сторінки цілком:
 * прохід по 100 студіях давав нуль контактів при 267 завантажених сторінках.
 *
 * Правило свідомо вужче за основне: таке імʼя приймається тільки впритул до
 * посади і тільки на сторінці команди, інакше в контакти полізли б підписи
 * кнопок і пунктів меню.
 */
const NOT_A_SINGLE_NAME =
  /^(home|about|team|contact|careers?|blog|news|services?|portfolio|works?|clients?|projects?|more|menu|next|back|prev|search|login|email|phone|address|company|people|culture|values|mission|vision|history|awards|partners|process|approach|hello|hi|ua|en|ru|pl|de)$/i;

const SINGLE_NAME_SHAPE = /^[A-ZА-ЯІЇЄҐ][\p{L}'’-]{2,19}$/u;

function looksLikeSingleName(line: string): boolean {
  if (NOT_A_SINGLE_NAME.test(line)) return false;
  if (NOT_A_NAME.test(line)) return false;
  // Сама посада теж одне слово з великої ("CEO", "Designer"), і імʼям вона не є.
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
  /*
   * Перевіряються всі згадки в рядку, а не перша. "Former CEO of GitHub" має дві:
   * "Former" і "GitHub", і достатньо однієї чужої, щоб рядок був відгуком, а не
   * своєю людиною. Раніше бралась лише перша, і порядок слів вирішував результат.
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

    // Імʼя без прізвища приймається лише впритул до посади: одне слово надто
    // схоже на пункт меню, щоб шукати його через рядок.
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
 * HTML-сутності назад у символи. Пошта регулярно пишеться саме так, щоб її не
 * зібрали роботи: `&#104;&#101;&#108;...` або хоча б `&#64;` замість равлика.
 */
export function decodeEntities(html: string): string {
  return html
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Розшифровка Cloudflare Email Protection.
 *
 * Cloudflare замінює адресу на `<a href="/cdn-cgi/l/email-protection#1a2b3c">` або
 * `<span data-cfemail="1a2b3c">`, а справжній текст збирає скриптом уже в браузері.
 * У HTML її після цього немає взагалі, і саме тому пошта, яку видно очима на сайті,
 * не знаходилась. Схема проста: перший байт це ключ, решта байтів з ним у XOR.
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
 * Розмаскування ручних хитрощів: "hello (at) studio dot com" і сусіди. Такі написи
 * ставлять саме для того, щоб адресу не забрав робот, але людина її читає, тому
 * і радар мусить, інакше він зупиняється там, де власник читає адресу очима.
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
    // Хвости на кшталт .png трапляються, коли адреса склеїлась з іменем файла.
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
    if (/^(example|test|your|name|email|user|domain|sentry|wordpress)@/.test(email)) return;
    if (seen.has(email)) return;
    seen.add(email);
    result.push({ email, generic: GENERIC_MAILBOX.test(email) });
  };

  const decoded = decodeEntities(html);

  // Cloudflare йде першим: після нього адреса зʼявляється там, де її взагалі не було.
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
      // Побитий percent-encoding це не привід валити розбір усієї сторінки.
    }
  }

  const plain = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  for (const match of decoded.matchAll(plain)) add(match[0]);

  /*
   * Той самий пошук по видимому тексту, а не по розмітці. Адреса часто розрізана
   * тегами: `<span>hello</span>@<span>studio.com</span>`, і в сирому HTML вона не
   * збігається з жодним шаблоном, а в тексті сторінки збігається.
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
    // Розмітка і текст разом: перше каже, на чому зроблений сайт, друге, що вони вміють.
    techHints: detectStack(html),
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

/**
 * Адреси скриптів того самого домену. Потрібні для сайтів, які малюють вміст у
 * браузері: у HTML там порожній `<div id="root">`, а пошта лежить у бандлі, який
 * цей div заповнює. Ходити туди дорого, тому це останній крок і тільки коли в
 * розмітці не знайшлось жодної адреси.
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
      // Побитий src це не привід валити обхід.
    }
  }

  /*
   * Спершу головні бандли: у них лежить каркас сторінки з підвалом і контактами.
   * Дрібні чанки це найчастіше окремі маршрути, і адреси в них немає.
   */
  const weight = (url: string) => (/(main|index|app|bundle|entry)/i.test(url) ? 0 : 1);
  return [...new Set(urls)].sort((a, b) => weight(a) - weight(b));
}

/** Скільки тексту видно без скриптів. Порожня сторінка означає рендер у браузері. */
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
  /** Сайт малює вміст скриптом: у HTML тексту майже немає. Пояснює порожній результат. */
  clientRendered: boolean;
  /**
   * Головна взагалі не відкрилась серверу: таймаут, 403 від захисту, мертвий домен.
   * Це не те саме, що "нічого не знайшли", і поводитись з цим треба інакше.
   */
  reachable: boolean;
}

/**
 * Обійти сайт однієї компанії. Ліміт сторінок навмисно малий: цінність швидко падає,
 * а `fetchText` тримає паузу на домен, тому кожна зайва сторінка це секунда прогону.
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
    // Двісті символів це менше за один абзац: такий HTML це каркас, а не сторінка.
    result.clientRendered = visibleTextLength(homepage) < 200;
  } catch (error) {
    log.warn({ domain: company.domain, err: String(error) }, 'головна не відкрилась, enrichment пропущено');
    return result;
  }

  const byName = new Map<string, FoundContact>();
  const emails: { email: string; generic: boolean; sourceUrl: string }[] = [];

  const harvest = (html: string, url: string) => {
    /*
     * Стек добирається з кожної відкритої сторінки, а не тільки з головної.
     * На головній часто стоїть слоган і три картинки, а перелік технологій живе
     * на сторінці послуг, і саме він показує, чи має сенс писати цій студії.
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

  // З головної беремо тільки пошту і ознаки живості, людей звідти не беремо.
  harvest(homepage, base);

  const candidates = [
    ...findTeamLinks(homepage, base),
    ...TEAM_PATHS.map((path) => `${base}${path}`),
  ];

  // Сторінки послуг ідуть окремим невеликим бюджетом, щоб не з'їдати ліміт у людей.
  const servicePages = SERVICE_PATHS.map((path) => `${base}${path}`);

  for (const url of [...new Set([...candidates.slice(0, maxPages), ...servicePages.slice(0, maxServicePages)])]) {
    if (url === base) continue;
    try {
      const res = await fetchText(url);
      result.pagesFetched += 1;
      harvest(res.body, url);
    } catch {
      // 404 на вгаданому шляху це нормальний результат.
    }
  }

  /*
   * Досі жодної адреси. Найчастіша причина це сайт на React або іншому клієнтському
   * рушії: розмітка порожня, а підвал з поштою збирає скрипт уже в браузері. Тоді
   * читаємо самі бандли, адреса лежить у них рядком.
   */
  if (emails.length === 0) {
    for (const url of findScripts(homepage, base).slice(0, maxScripts)) {
      try {
        const res = await fetchText(url);
        result.pagesFetched += 1;
        for (const item of extractEmails(res.body)) emails.push({ ...item, sourceUrl: url });
        if (emails.length > 0) break;
      } catch {
        // Бандл міг переїхати або бути завеликим, це не привід валити обхід.
      }
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

  const hasEmail = result.contacts.some((item) => item.email);

  /*
   * Позначка часу ставиться завжди, навіть коли сайт не відкрився зовсім.
   *
   * Раніше вона писалась тільки при успіху, і компанія з мертвою або закритою
   * головною лишалась із порожнім `last_checked`, тобто вічно першою в черзі:
   * кожна наступна партія бралась саме за неї і знову впиралась у ту саму стіну.
   */
  const patch: Record<string, unknown> = { lastChecked: Date.now() };

  /*
   * Два різні випадки, а черга одна: сторінку має відкрити браузер.
   *
   * Перший, сайт намальований скриптом, і в сирому HTML немає нічого. Другий,
   * головна не віддалась серверу взагалі: захист відповів 403 на запит без
   * справжнього браузера. У браузері власника обидва відкриються нормально,
   * тому обидва йдуть у чергу розширення, а не в нікуди.
   */
  patch.needsBrowser = !hasEmail && (result.clientRendered || !result.reachable);

  if (result.signals) {
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
  }

  await db.update(companies).set(patch).where(eq(companies.id, result.companyId));

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
    /*
     * Останній критерій це час дотику, найдавніші попереду. Компанія, чий сайт не
     * відкрився, лишається без контактів і без нього назавжди трималась би на початку
     * черги: кожна наступна партія бралась би за ту саму двадцятку.
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

/** Скільки компаній ще чекає на збір контактів. Інтерфейс за цим числом зупиняє прохід. */
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
  /** Скільки компаній лишилось після цієї партії. Нуль означає, що збір закінчено. */
  remaining: number;
  /** Сайтів, які малюють вміст скриптом. Пояснює порожній результат, а не ховає його. */
  clientRendered: number;
  /** Сайтів, які взагалі не відкрились серверу: таймаут, 403 від захисту, мертвий домен. */
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
        // Один недоступний сайт не має валити прохід по решті сотні.
        stats.errors.push(`${company.domain}: ${error instanceof Error ? error.message : String(error)}`);
        // Позначка часу навіть на невдачі, інакше ця компанія вічно перша в черзі.
        await getDb()
          .update(companies)
          .set({ lastChecked: Date.now() })
          .where(eq(companies.id, company.id));
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

/**
 * Черга для розширення: домени, з яких серверний обхід нічого не дістав, бо сторінку
 * малює скрипт. Розширення відкриває їх у власному браузері власника, читає з готового
 * DOM і присилає знайдене сюди ж.
 *
 * Ліміт малий навмисно: це прохід по чужих сайтах у справжньому браузері, з паузами,
 * як гортає людина. Розділ 4 CLAUDE.md.
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

export interface BrowserFindings {
  companyId?: number | null;
  domain: string;
  emails?: { email: string; name?: string | null; role?: string | null }[];
  techHints?: string[];
  copyrightYear?: number | null;
  lastPostAt?: number | null;
}

export interface BrowserSaveResult {
  companyId: number | null;
  contactsAdded: number;
  techAdded: number;
}

/**
 * Прийняти те, що розширення прочитало з намальованої сторінки.
 *
 * Прапорець `needs_browser` знімається в будь-якому разі, навіть коли нічого не
 * знайшлось: сторінку вже відкривали у браузері, і ганяти її туди щоразу заново
 * означало б вічну чергу з тих самих доменів.
 */
export async function saveBrowserFindings(input: BrowserFindings): Promise<BrowserSaveResult> {
  const db = getDb();
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error(`невалідний домен: ${input.domain}`);

  const [company] = await db.select().from(companies).where(eq(companies.domain, domain));
  if (!company) return { companyId: null, contactsAdded: 0, techAdded: 0 };

  let contactsAdded = 0;
  for (const item of (input.emails ?? []).slice(0, MAX_GENERIC + MAX_PEOPLE)) {
    const email = normalizeEmail(item.email);
    if (!email) continue;
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

  log.info(
    { domain, contactsAdded, tech: techHints.length },
    'дані з браузера збережено',
  );

  return {
    companyId: company.id,
    contactsAdded,
    techAdded: techHints.length - company.techHints.length,
  };
}
