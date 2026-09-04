import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GETRO_NETWORKS, GETRO_QUERIES, parseGetro } from '../src/sources/boards/getro.js';

const listing = readFileSync('fixtures/getro/techstars-frontend.html', 'utf8');
const featured = readFileSync('fixtures/getro/techstars-jobs.html', 'utf8');

describe('getro', () => {
  it('розбирає сторінку пошуку і не повертає нуль', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    // Правило 3 в CLAUDE.md: порожній результат це помилка, не успіх.
    expect(rows.length).toBeGreaterThan(5);
  });

  it('бере назву, посилання і зовнішній id', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    const row = rows[0]!;

    expect(row.source).toBe('getro');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/jobs\.techstars\.com\/companies\/[a-z0-9._-]+\/jobs\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
    expect(row.companySlug).toBeTruthy();
  });

  it('витягає назву компанії і локацію з підписаних полів', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    expect(rows.some((row) => row.companyName)).toBe(true);
    expect(rows.some((row) => row.location)).toBe(true);
  });

  it('позначає віддалені вакансії за текстом локації', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    for (const row of rows) {
      if (row.location && /remote/i.test(row.location)) expect(row.remote).toBe(true);
    }
  });

  it('домен компанії зі списку невідомий і чесно лишається null', () => {
    // Getro не показує сайт у списку. Домен доважується окремим запитом у fetch,
    // і вигадувати його з домену борду не можна: це зламало б дедуп.
    const rows = parseGetro(listing, 'jobs.techstars.com');
    expect(rows.every((row) => row.companyDomain === null)).toBe(true);
  });

  it('одна вакансія не дублюється, навіть якщо посилання трапилось двічі', () => {
    const rows = parseGetro(listing + listing, 'jobs.techstars.com');
    const urls = rows.map((row) => row.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('сторінка без пошуку теж розбирається', () => {
    expect(parseGetro(featured, 'jobs.techstars.com').length).toBeGreaterThan(0);
  });

  it('порожній html дає порожній список, а не падіння', () => {
    expect(parseGetro('<html><body>нічого</body></html>', 'jobs.techstars.com')).toEqual([]);
  });

  it('мережі і запити описані конфігом, а не зашиті в код', () => {
    expect(GETRO_NETWORKS.length).toBeGreaterThan(1);
    expect(GETRO_QUERIES).toContain('frontend');
  });

  it('усі мережі мають унікальні id і різні хости', () => {
    const ids = GETRO_NETWORKS.map((network) => network.id);
    const hosts = GETRO_NETWORKS.map((network) => network.host);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('кількість запитів на прохід лишається розумною', () => {
    /*
     * Кожен запит це похід на чужий сайт. Стеля потрібна, щоб додавання мереж
     * не перетворилось непомітно на сотню звернень за прохід. Домени компаній
     * сюди не входять: вони лежать у постійному кеші і тягнуться один раз.
     */
    expect(GETRO_NETWORKS.length * GETRO_QUERIES.length).toBeLessThanOrEqual(40);
  });
});
