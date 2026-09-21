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

describe('parsing a team page', () => {
  it('takes names and roles when the name comes before the role', () => {
    const people = extractPeople(withPeople, 'https://triare.net/about-us/');
    const names = people.map((person) => person.name);

    expect(names).toContain('Boris Abazher');
    expect(names).toContain('Anton Malyy');

    const cto = people.find((person) => person.role?.includes('CTO'));
    expect(cto?.name).toBe('Anton Malyy');
  });

  it('takes names when the role is a separate short line', () => {
    const people = extractPeople(leadership, 'https://utility.agency/about');
    const roles = people.map((person) => person.role);

    expect(people.length).toBeGreaterThan(0);
    expect(roles.some((role) => role === 'CEO' || role === 'CTO')).toBe(true);
  });

  it('does not invent people where there are none', () => {
    const people = extractPeople(without, 'https://swovo.com/about');
    // A page without a team block. A few matches are possible, but not dozens.
    expect(people.length).toBeLessThan(5);
  });

  it('the role is trimmed to the title itself, without "at Company"', () => {
    const people = extractPeople(withPeople, 'https://triare.net/about-us/');
    expect(people.every((person) => !/ at /i.test(person.role ?? ''))).toBe(true);
  });

  it('a cookie banner is not read as the COO title', () => {
    const html = '<div>We use cookies to improve cooperation</div><span>Cookie policy</span>';
    expect(extractPeople(html, 'https://example.com')).toHaveLength(0);
  });

  it('a company name is not taken for a person name', () => {
    const html = '<div><p>Acme Digital Studio</p><p>CTO</p></div>';
    expect(extractPeople(html, 'https://example.com')).toHaveLength(0);
  });
});

describe('team cards without surnames', () => {
  const people = extractPeople(singleNames, 'https://rubyroidlabs.com/team');

  /*
   * Half of studio sites sign a card with the first name only. The "a name is two words" rule
   * skipped such pages entirely, and a pass over 100 studios gave zero contacts from 267
   * downloaded pages. That is exactly the silent failure rule 3 of CLAUDE.md is written against.
   */
  it('a first name next to a title counts as a contact', () => {
    expect(people.length).toBeGreaterThan(0);
    expect(people.map((person) => person.name)).toContain('Pavel');
  });

  /*
   * "VP of Operations" was read as a mention of a foreign company "Operations" and dropped.
   * So enrichment threw away exactly the titles it exists for: section 9 of CLAUDE.md asks for
   * Head of Engineering and the like.
   */
  it('a title with a department after of is not a foreign company', () => {
    const roles = people.map((person) => person.role);
    expect(roles.some((role) => /VP of Engineering/i.test(role ?? ''))).toBe(true);
  });

  it('menu items and button labels do not become names', () => {
    const names = people.map((person) => person.name?.toLowerCase());
    for (const junk of ['home', 'about', 'team', 'contact', 'careers', 'blog', 'services']) {
      expect(names).not.toContain(junk);
    }
  });
});

describe('filtering out outsiders', () => {
  /*
   * The first run over ten companies gave 104 contacts. Almost all were investors and
   * testimonial authors from landing pages, so each class of error is pinned down separately.
   */
  it('a former title at another company is an investor, not a contact', () => {
    const html = '<div><p>Nat Friedman</p><p>Former CEO of GitHub</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('a title naming another company is dropped too', () => {
    const html = '<div><p>David Cramer</p><p>Founder and CEO of Sentry</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('an at sign in the caption also means another company', () => {
    const html = '<div><p>Tom Preston-Werner</p><p>Founder @ GitHub</p></div>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('navigation is not read as a person', () => {
    const html = '<a>Brand Assets</a><a>Partner Catalog</a><a>System Status</a><a>Become a Partner</a>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('a form field label is not read as a name', () => {
    const html = '<label>First Name</label><span>Co-founder</span>';
    expect(extractPeople(html, 'https://acme.com/about')).toHaveLength(0);
  });

  it('an own title without another company stays', () => {
    const html = '<div><p>Anton Malyy</p><p>CTO</p></div>';
    const people = extractPeople(html, 'https://acme.com/about');
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe('Anton Malyy');
  });

  it('people come only from team pages, the home page is testimonials and investors', () => {
    expect(isTeamPage('https://acme.com/about-us/')).toBe(true);
    expect(isTeamPage('https://acme.com/team')).toBe(true);
    expect(isTeamPage('https://acme.com/contact')).toBe(true);
    expect(isTeamPage('https://acme.com')).toBe(false);
    expect(isTeamPage('https://acme.com/blog/hiring')).toBe(false);
  });
});

describe('email', () => {
  it('finds an address in mailto and marks generic mailboxes', () => {
    const found = extractEmails(withPeople);
    const welcome = found.find((item) => item.email === 'welcome@triare.net');

    expect(welcome).toBeDefined();
    expect(welcome!.generic).toBe(true);
  });

  it('a personal address is not marked generic', () => {
    const found = extractEmails('<a href="mailto:anton.malyy@triare.net">email</a>');
    expect(found[0]).toEqual({ email: 'anton.malyy@triare.net', generic: false });
  });

  it('drops files and examples that look like an address', () => {
    const html = '<img src="logo@2x.png"><span>your@email.com</span><span>test@example.com</span>';
    expect(extractEmails(html)).toHaveLength(0);
  });

  it('one address is not duplicated, even when it appears in mailto and in text', () => {
    const html = '<a href="mailto:hi@acme.com">hi@acme.com</a> hi@acme.com';
    expect(extractEmails(html)).toHaveLength(1);
  });
});

describe('profiles and signs of life', () => {
  it('finds LinkedIn on the page', () => {
    expect(extractProfiles(leadership).linkedin.length).toBeGreaterThan(0);
  });

  it('does not treat service paths of X as a profile link', () => {
    const html = '<a href="https://twitter.com/intent/tweet">share</a>';
    expect(extractProfiles(html).x).toHaveLength(0);
  });

  it('extracts the copyright year, the main sign of a dead site', () => {
    expect(extractSignals('<footer>© 2019 Acme</footer>').copyrightYear).toBe(2019);
    expect(extractSignals('<footer>Copyright 2026 Acme</footer>').copyrightYear).toBe(2026);
  });

  it('notices a blog', () => {
    expect(extractSignals('<a href="/blog/hello">post</a>').hasBlog).toBe(true);
    expect(extractSignals('<a href="/pricing">pricing</a>').hasBlog).toBe(false);
  });
});

describe('site crawl', () => {
  it('collects team page links only within the domain', () => {
    const html = `
      <a href="/about-us">About us</a>
      <a href="/team">Our team</a>
      <a href="https://other.com/team">another site</a>
      <a href="/pricing">Pricing</a>
    `;
    const links = findTeamLinks(html, 'https://acme.com');

    expect(links).toContain('https://acme.com/about-us');
    expect(links).toContain('https://acme.com/team');
    expect(links.some((url) => url.includes('other.com'))).toBe(false);
    expect(links.some((url) => url.includes('pricing'))).toBe(false);
  });

  it('flattening html drops scripts and styles', () => {
    const lines = toLines('<style>.a{color:red}</style><script>var x=1</script><p>Text</p>');
    expect(lines).toEqual(['Text']);
  });
});

describe('who enrichment takes first', () => {
  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
    const { sqlite } = runMigrations();
    sqlite.close();

    // The creation order is deliberately bad: the giant first, as it was in the database.
    await upsertCompany({ name: 'Giant', domain: 'giant.com', source: 'greenhouse' });
    await upsertCompany({ name: 'Agency', domain: 'agency.com', source: 'clutch', tags: ['Web Design'] });
    await upsertCompany({ name: 'Seed', domain: 'seed.com', source: 'getro', tags: ['startup'] });
    await upsertCompany({ name: 'Studio', domain: 'studio.com', source: 'clutch', tags: ['Web Design'] });
  });

  /*
   * Without sorting the pass took the first table rows, that is, product giants with no team
   * page with contacts, and gave zero contacts per hundred domains. It looked like broken
   * enrichment, while it was simply looking in the wrong place.
   */
  it('studios and startups go ahead of product companies', async () => {
    const order = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);

    expect(order[0]).toBe('agency.com');
    expect(order.indexOf('seed.com')).toBeLessThan(order.indexOf('giant.com'));
  });

  /*
   * The pass runs in batches of a few companies, so the queue has to move. A company whose site
   * did not open stays without contacts, and without this rule it would stay at the head of the
   * queue forever: every batch would take the same one.
   */
  it('a recently checked company goes to the end of the queue among equals', async () => {
    const before = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);
    expect(before.indexOf('agency.com')).toBeLessThan(before.indexOf('studio.com'));

    await getDb()
      .update(companies)
      .set({ lastChecked: Date.now() })
      .where(eq(companies.domain, 'agency.com'));

    const after = (await candidatesForEnrichment({ limit: 10 })).map((company) => company.domain);
    expect(after.indexOf('studio.com')).toBeLessThan(after.indexOf('agency.com'));
  });

  it('reports how many companies are left in the queue', async () => {
    expect(await pendingEnrichment()).toBe(4);
  });
});

/*
 * An email visible on a site was regularly not found. There are exactly four causes, and none of
 * them is a missing address: Cloudflare hides it, entities hide it, tags cut it, or it is not in
 * the HTML at all because the page is rendered by script.
 */
describe('email hidden by the markup', () => {
  it('Cloudflare Email Protection is decoded', () => {
    // The same XOR Cloudflare encodes it with: the first byte is the key.
    const plain = 'hello@studio.com';
    const key = 0x2a;
    const hex =
      key.toString(16).padStart(2, '0') +
      [...plain].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

    expect(decodeCfEmail(hex)).toBe(plain);
    expect(extractEmails(`<a href="/cdn-cgi/l/email-protection#${hex}">Email</a>`)[0]?.email).toBe(plain);
    expect(extractEmails(`<span data-cfemail="${hex}">[protected]</span>`)[0]?.email).toBe(plain);
  });

  it('garbage instead of hex does not break parsing', () => {
    expect(decodeCfEmail('zzzz')).toBeNull();
    expect(decodeCfEmail('2a2b')).toBeNull();
  });

  it('an address written with entities is read', () => {
    const html = '<p>&#104;&#101;&#108;&#108;&#111;&#64;studio.com</p>';
    expect(extractEmails(html)[0]?.email).toBe('hello@studio.com');
  });

  it('an address split by tags is assembled from the page text', () => {
    const html = '<p><span>hello</span>@<span>studio.com</span></p>';
    expect(extractEmails(html)[0]?.email).toBe('hello@studio.com');
  });

  it('an address spelled out in words is read too', () => {
    expect(unmaskEmails('hello (at) studio dot com')).toBe('hello@studio.com');
    expect(unmaskEmails('hello собака studio крапка com')).toBe('hello@studio.com');
  });

  it('empty markup is a sign of client-side rendering', () => {
    expect(visibleTextLength('<body><div id="root"></div><script>var a=1</script></body>')).toBe(0);
    expect(visibleTextLength(`<body><p>${'word '.repeat(60)}</p></body>`)).toBeGreaterThan(200);
  });

  it('bundles from the same domain are taken, foreign ones are not, main ones first', () => {
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
 * The browser queue. The server-side crawl cannot read a site rendered by script, so such
 * domains wait for the extension instead of dropping out of sight.
 */
describe('browser queue', () => {
  it('accepts what was found, adds the contact and clears the flag', async () => {
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
   * The flag is cleared even when nothing was found: the page has already been opened in a
   * browser, and sending it there again every time would mean an endless queue of the same ones.
   */
  it('an empty result closes the queue item too', async () => {
    const db = getDb();
    const { company } = await upsertCompany({ name: 'Mute', domain: 'mute-site.com', source: 'test' });
    await db.update(companies).set({ needsBrowser: true }).where(eq(companies.id, company.id));

    const saved = await saveBrowserFindings({ domain: 'mute-site.com', emails: [], techHints: [] });
    expect(saved.contactsAdded).toBe(0);

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.needsBrowser).toBe(false);
  });

  it('an unknown domain does not create a company', async () => {
    const saved = await saveBrowserFindings({ domain: 'nobody-knows-this.com', emails: [] });
    expect(saved.companyId).toBeNull();
  });

  /*
   * The domain comes from the tab address after redirects, so it differs from the database
   * every time a studio has moved. That used to be the end of it: the email was found and lost,
   * and it looked like an empty site.
   */
  it('finds the company by id when the tab domain differs', async () => {
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
   * The home page gives the pitch, the contact page gives the address, the team page gives names
   * with titles. They have to meet in one contact before writing, otherwise the database holds
   * two halves nobody can write a letter from.
   */
  it('joins a name from one page and an email from another into one contact', async () => {
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

    // The generic mailbox stays a separate row and is attributed to nobody.
    expect(rows.find((row) => row.email === 'hello@multi-site.com')?.name).toBeNull();
    // A person without an address is stored too: the email is searched for by name later.
    expect(rows.find((row) => row.name === 'Ihor Bondar')?.email).toBeNull();
  });

  it('does not attribute a generic mailbox to a person with a similar name', () => {
    expect(emailBelongsTo('anna@studio.com', 'Anna Koval')).toBe(true);
    expect(emailBelongsTo('a.koval@studio.com', 'Anna Koval')).toBe(true);
    expect(emailBelongsTo('hello@studio.com', 'Anna Koval')).toBe(false);
    // "ann" inside "announcements" is not Anna: the match has to be a whole word.
    expect(emailBelongsTo('announcements@studio.com', 'Anna Koval')).toBe(false);
  });
});

/*
 * A site that did not open for the server is not a dead end. Protection answers 403 exactly to
 * requests without a real browser, and in the owner's browser the same page opens, so such
 * domains go to the same queue as script-rendered ones.
 */
describe('a site that did not open for the server', () => {
  it('goes to the browser queue and gets a timestamp', async () => {
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
    // The timestamp is always set now, otherwise the company is forever first in line.
    expect(row!.lastChecked).not.toBeNull();
    expect((await browserQueue()).map((item) => item.domain)).toContain('closed-site.com');
  });

  it('a found address removes the need for a browser', async () => {
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
 * A full review on a button press. The crawl itself is not tested here: it goes to the network,
 * and its parts (discovery, enrichment, storage) are covered separately. What matters here is
 * that the button on a deleted company gives a clear error instead of staying silent.
 */
describe('reviewing one company', () => {
  it('a missing company is an error with its id', async () => {
    await expect(refreshCompany(999_999)).rejects.toThrow('999999');
  });
});
