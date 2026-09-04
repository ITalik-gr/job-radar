import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { candidatesForEnrichment } from '../src/pipeline/enrich.js';
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
});
