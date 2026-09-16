import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { refreshCompany } from '../src/pipeline/refresh.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { companies, contacts } from '../src/db/schema.js';
import {
  candidatesForEnrichment,
  pendingEnrichment,
  decodeCfEmail,
  unmaskEmails,
  visibleTextLength,
  findScripts,
  browserQueue,
  emailBelongsTo,
  saveBrowserFindings,
  saveEnrichment,
} from '../src/pipeline/enrich.js';
import {
  extractEmails,
  extractPeople,
  extractProfiles,
  extractSignals,
  findTeamLinks,
  isTeamPage,
  toLines,
} from '../src/pipeline/enrich.js';

const withPeople = readFileSync('fixtures/enrich/team-with-people.html', 'utf8');
const leadership = readFileSync('fixtures/enrich/team-leadership.html', 'utf8');
const without = readFileSync('fixtures/enrich/page-without-people.html', 'utf8');
const singleNames = readFileSync('fixtures/enrich/team-single-names.html', 'utf8');

describe('розбір сторінки команди', () => {
  it('бере імена і ролі, коли імʼя стоїть перед роллю', () => {
    const people = extractPeople(withPeople, 'https://triare.net/about-us/');
    const names = people.map((person) => person.name);

    expect(names).toContain('Boris Abazher');
    expect(names).toContain('Anton Malyy');

    const cto = people.find((person) => person.role?.includes('CTO'));
    expect(cto?.name).toBe('Anton Malyy');
  });

  it('бере імена, коли роль стоїть окремим коротким рядком', () => {
    const people = extractPeople(leadership, 'https://utility.agency/about');
    const roles = people.map((person) => person.role);

    expect(people.length).toBeGreaterThan(0);
    expect(roles.some((role) => role === 'CEO' || role === 'CTO')).toBe(true);
  });

  it('не вигадує людей там, де їх немає', () => {
    const people = extractPeople(without, 'https://swovo.com/about');
    // Сторінка без блока команди. Кілька збігів можливі, але це не десятки.
    expect(people.length).toBeLessThan(5);
  });

  it('роль обрізається до самої посади, без "at Компанія"', () => {
    const people = extractPeople(withPeople, 'https://triare.net/about-us/');
    expect(people.every((person) => !/ at /i.test(person.role ?? ''))).toBe(true);
  });

  it('cookie-банер не читається як посада COO', () => {
    const html = '<div>We use cookies to improve cooperation</div><span>Cookie policy</span>';
    expect(extractPeople(html, 'https://example.com')).toHaveLength(0);
  });

  it('назва компанії не приймається за імʼя людини', () => {
    const html = '<div><p>Acme Digital Studio</p><p>CTO</p></div>';
    expect(extractPeople(html, 'https://example.com')).toHaveLength(0);
  });
});

describe('картки команди без прізвищ', () => {
  const people = extractPeople(singleNames, 'https://rubyroidlabs.com/team');

  /*
   * Половина сайтів студій підписує картку самим імʼям. Правило "імʼя це два слова"
   * пропускало такі сторінки цілком, і прохід по 100 студіях давав нуль контактів
   * при 267 завантажених сторінках. Це рівно та мовчазна поразка, проти якої
   * написане правило 3 в CLAUDE.md.
   */
  it('імʼя без прізвища поруч із посадою рахується за контакт', () => {
    expect(people.length).toBeGreaterThan(0);
    expect(people.map((person) => person.name)).toContain('Pavel');
  });

  /*
   * "VP of Operations" читалось як згадка чужої компанії "Operations" і викидалось.
   * Тобто enrichment відкидав саме ті посади, заради яких написаний: розділ 9
   * у CLAUDE.md просить Head of Engineering і подібні.
   */
  it('посада з відділом після of не вважається чужою компанією', () => {
    const roles = people.map((person) => person.role);
    expect(roles.some((role) => /VP of Engineering/i.test(role ?? ''))).toBe(true);
  });

  it('пункти меню і підписи кнопок не стають іменами', () => {
    const names = people.map((person) => person.name?.toLowerCase());
    for (const junk of ['home', 'about', 'team', 'contact', 'careers', 'blog', 'services']) {
      expect(names).not.toContain(junk);
    }
  });
});

describe('відсів чужих людей', () => {
  /*
   * Перший прогін по десяти компаніях дав 104 контакти. Майже все це були інвестори
   * і автори відгуків з лендінгів, тому тут закріплено кожен клас помилки окремо.
   */
  it('колишня посада в чужій компанії це інвестор, а не контакт', () => {
    const html = '<div><p>Nat Friedman</p><p>Former CEO of GitHub</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('посада з назвою чужої компанії теж відкидається', () => {
    const html = '<div><p>David Cramer</p><p>Founder and CEO of Sentry</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('собака в підписі теж означає чужу компанію', () => {
    const html = '<div><p>Tom Preston-Werner</p><p>Founder @ GitHub</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('навігація не читається як людина', () => {
    const html = '<a>Brand Assets</a><a>Partner Catalog</a><a>System Status</a><a>Become a Partner</a>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('підпис поля форми не читається як імʼя', () => {
    const html = '<label>First Name</label><span>Co-founder</span>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('своя посада без чужої компанії лишається', () => {
    const html = '<div><p>Anton Malyy</p><p>CTO</p></div>';
    const people = extractPeople(html, 'https://acme.com/about');
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe('Anton Malyy');
  });

  it('людей беремо тільки зі сторінок команди, головна це відгуки і інвестори', () => {
    expect(isTeamPage('https://acme.com/about-us/')).toBe(true);
    expect(isTeamPage('https://acme.com/team')).toBe(true);
    expect(isTeamPage('https://acme.com/contact')).toBe(true);
    expect(isTeamPage('https://acme.com')).toBe(false);
    expect(isTeamPage('https://acme.com/blog/hiring')).toBe(false);
  });
});

describe('пошта', () => {
  it('знаходить адресу з mailto і позначає загальні скриньки', () => {
    const found = extractEmails(withPeople);
    const welcome = found.find((item) => item.email === 'welcome@triare.net');

    expect(welcome).toBeDefined();
    expect(welcome!.generic).toBe(true);
  });

  it('іменна адреса не позначається загальною', () => {
    const found = extractEmails('<a href="mailto:anton.malyy@triare.net">пошта</a>');
    expect(found[0]).toEqual({ email: 'anton.malyy@triare.net', generic: false });
  });

  it('відкидає файли і приклади, які виглядають як адреса', () => {
    const html = '<img src="logo@2x.png"><span>your@email.com</span><span>test@example.com</span>';
    expect(extractEmails(html)).toHaveLength(0);
  });

  it('одна адреса не дублюється, навіть якщо трапилась і в mailto, і в тексті', () => {
    const html = '<a href="mailto:hi@acme.com">hi@acme.com</a> hi@acme.com';
    expect(extractEmails(html)).toHaveLength(1);
  });
});

describe('профілі і ознаки живості', () => {
  it('знаходить LinkedIn на сторінці', () => {
    expect(extractProfiles(leadership).linkedin.length).toBeGreaterThan(0);
  });

  it('не вважає посиланням на профіль службові шляхи X', () => {
    const html = '<a href="https://twitter.com/intent/tweet">поділитись</a>';
    expect(extractProfiles(html).x).toHaveLength(0);
  });

  it('витягає рік копірайту, це головна ознака мертвого сайту', () => {
    expect(extractSignals('<footer>© 2019 Acme</footer>').copyrightYear).toBe(2019);
    expect(extractSignals('<footer>Copyright 2026 Acme</footer>').copyrightYear).toBe(2026);
  });

  it('бачить наявність блогу', () => {
    expect(extractSignals('<a href="/blog/hello">пост</a>').hasBlog).toBe(true);
    expect(extractSignals('<a href="/pricing">ціни</a>').hasBlog).toBe(false);
  });
});

describe('обхід сайту', () => {
  it('збирає посилання на сторінки команди тільки в межах домену', () => {
    const html = `
      <a href="/about-us">About us</a>
      <a href="/team">Our team</a>
      <a href="https://other.com/team">чужий сайт</a>
      <a href="/pricing">Pricing</a>
    `;
    const links = findTeamLinks(html, 'https://acme.com');

    expect(links).toContain('https://acme.com/about-us');
    expect(links).toContain('https://acme.com/team');
    expect(links.some((url) => url.includes('other.com'))).toBe(false);
    expect(links.some((url) => url.includes('pricing'))).toBe(false);
  });

  it('сплощення html викидає скрипти і стилі', () => {
    const lines = toLines('<style>.a{color:red}</style><script>var x=1</script><p>Текст</p>');
    expect(lines).toEqual(['Текст']);
  });
});

describe('кого enrichment бере першим', () => {
  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
    const { sqlite } = runMigrations();
    sqlite.close();

    // Порядок створення навмисно поганий: гігант першим, як воно й лежало в базі.
    await upsertCompany({ name: 'Giant', domain: 'giant.com', source: 'greenhouse' });
    await upsertCompany({ name: 'Agency', domain: 'agency.com', source: 'clutch', tags: ['Web Design'] });
    await upsertCompany({ name: 'Seed', domain: 'seed.com', source: 'getro', tags: ['startup'] });
    await upsertCompany({ name: 'Studio', domain: 'studio.com', source: 'clutch', tags: ['Web Design'] });
  });

  /*
   * Без сортування прохід брав перші рядки таблиці, тобто продуктових гігантів,
   * у яких сторінки команди з контактами немає, і давав нуль контактів на сотню
   * доменів. Це виглядало як зламаний enrichment, хоча він просто шукав не там.
   */
  it('студії і стартапи йдуть попереду продуктових', async () => {
    const order = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);

    expect(order[0]).toBe('agency.com');
    expect(order.indexOf('seed.com')).toBeLessThan(order.indexOf('giant.com'));
  });

  /*
   * Прохід іде партіями по кілька компаній, тому черга мусить рухатись. Компанія,
   * чий сайт не відкрився, лишається без контактів і без цього правила трималась би
   * на початку черги вічно: кожна партія бралась би за ту саму.
   */
  it('перевірена нещодавно йде в кінець черги серед рівних', async () => {
    const before = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);
    expect(before.indexOf('agency.com')).toBeLessThan(before.indexOf('studio.com'));

    await getDb()
      .update(companies)
      .set({ lastChecked: Date.now() })
      .where(eq(companies.domain, 'agency.com'));

    const after = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);
    expect(after.indexOf('studio.com')).toBeLessThan(after.indexOf('agency.com'));
  });

  it('каже, скільки компаній лишилось у черзі', async () => {
    expect(await pendingEnrichment()).toBe(4);
  });
});

/*
 * Пошта, яку видно очима на сайті, регулярно не знаходилась. Причин рівно чотири,
 * і жодна з них не про те, що адреси немає: її ховає Cloudflare, ховають сутності,
 * ріжуть теги, або її взагалі немає в HTML, бо сторінку малює скрипт.
 */
describe('пошта, яку ховає верстка', () => {
  it('Cloudflare Email Protection розшифровується', () => {
    // Той самий XOR, яким його кодує Cloudflare: перший байт це ключ.
    const plain = 'hello@studio.com';
    const key = 0x2a;
    const hex =
      key.toString(16).padStart(2, '0') +
      [...plain].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

    expect(decodeCfEmail(hex)).toBe(plain);
    expect(extractEmails(`<a href="/cdn-cgi/l/email-protection#${hex}">Email</a>`)[0]?.email).toBe(plain);
    expect(extractEmails(`<span data-cfemail="${hex}">[protected]</span>`)[0]?.email).toBe(plain);
  });

  it('сміття замість hex не ламає розбір', () => {
    expect(decodeCfEmail('zzzz')).toBeNull();
    expect(decodeCfEmail('2a2b')).toBeNull();
  });

  it('адреса, записана сутностями, читається', () => {
    const html = '<p>&#104;&#101;&#108;&#108;&#111;&#64;studio.com</p>';
    expect(extractEmails(html)[0]?.email).toBe('hello@studio.com');
  });

  it('адреса, розрізана тегами, збирається з тексту сторінки', () => {
    const html = '<p><span>hello</span>@<span>studio.com</span></p>';
    expect(extractEmails(html)[0]?.email).toBe('hello@studio.com');
  });

  it('написання словами теж читається', () => {
    expect(unmaskEmails('hello (at) studio dot com')).toBe('hello@studio.com');
  });

  it('порожня розмітка це ознака клієнтського рендера', () => {
    expect(visibleTextLength('<body><div id="root"></div><script>var a=1</script></body>')).toBe(0);
    expect(visibleTextLength(`<body><p>${'слово '.repeat(60)}</p></body>`)).toBeGreaterThan(200);
  });

  it('бандли того самого домену беруться, чужі ні, головні першими', () => {
    const html = `
      <script src="/assets/chunk-42.js"></script>
      <script src="https://cdn.other.com/analytics.js"></script>
      <script src="/assets/main-abc.js"></script>
      <script src="/style.css"></script>
    `;
    const found = findScripts(html, 'https://studio.com');

    expect(found[0]).toBe('https://studio.com/assets/main-abc.js');
    expect(found).toHaveLength(2);
    expect(found.some((url) => url.includes('other.com'))).toBe(false);
  });
});

/*
 * Черга для браузера. Сайт, намальований скриптом, серверний обхід читати не вміє,
 * тому такі домени чекають на розширення, а не пропадають з поля зору.
 */
describe('черга для браузера', () => {
  it('приймає знайдене, заводить контакт і знімає прапорець', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Spa', domain: 'spa-site.com', source: 'test' });
    await db.update(companies).set({ needsBrowser: true }).where(eq(companies.id, company.id));

    expect((await browserQueue()).map((row) => row.domain)).toContain('spa-site.com');

    const saved = await saveBrowserFindings({
      domain: 'spa-site.com',
      emails: [{ email: 'Hello@Spa-Site.com', name: 'Ola', role: 'CTO' }],
      techHints: ['sanity', 'next.js'],
      copyrightYear: 2026,
    });

    expect(saved.contactsAdded).toBe(1);

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.needsBrowser).toBe(false);
    expect(row!.techHints).toEqual(expect.arrayContaining(['sanity', 'next.js']));
    expect(row!.copyrightYear).toBe(2026);
    expect((await browserQueue()).map((item) => item.domain)).not.toContain('spa-site.com');
  });

  /*
   * Прапорець знімається навіть коли нічого не знайшлось: сторінку вже відкривали
   * у браузері, і ганяти її туди щоразу заново означало б вічну чергу з тих самих.
   */
  it('порожній результат теж закриває чергу', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Mute', domain: 'mute-site.com', source: 'test' });
    await db.update(companies).set({ needsBrowser: true }).where(eq(companies.id, company.id));

    const saved = await saveBrowserFindings({ domain: 'mute-site.com', emails: [], techHints: [] });
    expect(saved.contactsAdded).toBe(0);

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.needsBrowser).toBe(false);
  });

  it('невідомий домен не створює компанію', async () => {
    const saved = await saveBrowserFindings({ domain: 'nobody-knows-this.com', emails: [] });
    expect(saved.companyId).toBeNull();
  });

  /*
   * Домен береться з адреси вкладки вже після редиректів, тому він розходиться з
   * базою щоразу, коли студія переїхала. Раніше на цьому все й закінчувалось:
   * пошта знаходилась і зникала, а виглядало це як порожній сайт.
   */
  it('знаходить компанію по номеру, коли домен у вкладці інший', async () => {
    const { company } = await upsertCompany({ name: 'Moved', domain: 'moved-old.com', source: 'test' });

    const saved = await saveBrowserFindings({
      companyId: company.id,
      domain: 'moved-new.com',
      emails: [{ email: 'hello@moved-new.com' }],
    });

    expect(saved.companyId).toBe(company.id);
    expect(saved.contactsAdded).toBe(1);
  });

  /*
   * Головна віддає презентацію, контакти віддають адресу, а сторінка команди імена
   * з посадами. Зійтись в один контакт вони мають ще до запису, інакше в базі
   * лежать дві половинки, з яких лист не напишеш.
   */
  it('збирає імʼя з однієї сторінки і пошту з іншої в один контакт', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Multi', domain: 'multi-site.com', source: 'test' });

    const saved = await saveBrowserFindings({
      companyId: company.id,
      domain: 'multi-site.com',
      emails: [{ email: 'anna.koval@multi-site.com' }, { email: 'hello@multi-site.com' }],
      pages: [
        { url: 'https://multi-site.com/', lines: ['We build things'] },
        { url: 'https://multi-site.com/team', lines: ['Anna Koval', 'CTO', 'Ihor Bondar', 'Head of Engineering'] },
      ],
    });

    expect(saved.pagesRead).toBe(2);
    expect(saved.peopleFound).toBe(2);

    const rows = await db.select().from(contacts).where(eq(contacts.companyId, company.id));
    const anna = rows.find((row) => row.name === 'Anna Koval');
    expect(anna?.email).toBe('anna.koval@multi-site.com');
    expect(anna?.role).toBe('CTO');

    // Загальна скринька лишається окремим рядком і нікому не приписується.
    expect(rows.find((row) => row.email === 'hello@multi-site.com')?.name).toBeNull();
    // Людина без адреси теж зберігається: далі по імені шукається пошта.
    expect(rows.find((row) => row.name === 'Ihor Bondar')?.email).toBeNull();
  });

  it('не приписує загальну скриньку людині з схожим іменем', () => {
    expect(emailBelongsTo('anna@studio.com', 'Anna Koval')).toBe(true);
    expect(emailBelongsTo('a.koval@studio.com', 'Anna Koval')).toBe(true);
    expect(emailBelongsTo('hello@studio.com', 'Anna Koval')).toBe(false);
    // "ann" усередині "announcements" це не Anna: збіг має бути по цілому слову.
    expect(emailBelongsTo('announcements@studio.com', 'Anna Koval')).toBe(false);
  });
});

/*
 * Сайт, який не відкрився серверу, це не глухий кут. Захист відповідає 403 саме на
 * запит без справжнього браузера, а у браузері власника та сама сторінка відкриється,
 * тому такі домени йдуть у ту саму чергу, що й намальовані скриптом.
 */
describe('сайт, який не відкрився серверу', () => {
  it('потрапляє в чергу для браузера і отримує позначку часу', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Closed', domain: 'closed-site.com', source: 'test' });

    await saveEnrichment({
      companyId: company.id,
      domain: 'closed-site.com',
      contacts: [],
      signals: null,
      pagesFetched: 0,
      clientRendered: false,
      reachable: false,
    });

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.needsBrowser).toBe(true);
    // Позначка часу тепер ставиться завжди, інакше компанія вічно перша в черзі.
    expect(row!.lastChecked).not.toBeNull();
    expect((await browserQueue()).map((item) => item.domain)).toContain('closed-site.com');
  });

  it('знайдена адреса знімає потребу в браузері', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Found', domain: 'found-site.com', source: 'test' });

    await saveEnrichment({
      companyId: company.id,
      domain: 'found-site.com',
      contacts: [
        {
          name: null,
          role: 'general',
          email: 'hello@found-site.com',
          linkedin: null,
          xHandle: null,
          sourceUrl: 'https://found-site.com',
        },
      ],
      signals: null,
      pagesFetched: 1,
      clientRendered: true,
      reachable: true,
    });

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.needsBrowser).toBe(false);
  });
});

/*
 * Повний перегляд по кнопці. Сам обхід тут не перевіряється: він ходить у мережу,
 * а його частини (discovery, enrichment, збереження) накриті окремо. Тут важливо
 * інше, щоб кнопка на видаленій компанії давала зрозумілу помилку, а не мовчала.
 */
describe('перегляд однієї компанії', () => {
  it('неіснуюча компанія це помилка з номером', async () => {
    await expect(refreshCompany(999_999)).rejects.toThrow('999999');
  });
});
