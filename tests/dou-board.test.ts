import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOU_CATEGORIES, parseDou } from '../src/sources/boards/dou.js';

const frontend = readFileSync('fixtures/dou/vacancies-frontend.html', 'utf8');
const node = readFileSync('fixtures/dou/vacancies-node.html', 'utf8');

describe('dou як борд вакансій', () => {
  it('розбирає сторінку категорії і не повертає нуль', () => {
    // Правило 3 в CLAUDE.md: порожній результат це помилка, не успіх.
    expect(parseDou(frontend).length).toBeGreaterThan(10);
    expect(parseDou(node).length).toBeGreaterThan(10);
  });

  it('бере назву, посилання, зовнішній id і компанію', () => {
    const row = parseDou(frontend)[0]!;

    expect(row.source).toBe('dou:vacancies');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/jobs\.dou\.ua\/companies\/[^/]+\/vacancies\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
    expect(row.companyName).toBeTruthy();
    expect(row.companySlug).toBeTruthy();
  });

  it('назва компанії без сміття від іконки', () => {
    for (const row of parseDou(frontend)) {
      expect(row.companyName ?? '').not.toMatch(/<|img|src=/);
    }
  });

  it('українське "віддалено" читається як remote', () => {
    const rows = parseDou(frontend);
    const remote = rows.find((row) => /віддален/i.test(row.location ?? ''));

    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
  });

  it('вилка потрапляє в текст, бо окремого поля в схемі немає', () => {
    const rows = parseDou(frontend).concat(parseDou(node));
    const withSalary = rows.filter((row) => /\$|\d{3,}/.test(row.rawText));
    expect(withSalary.length).toBeGreaterThan(0);
  });

  it('домен компанії зі списку невідомий і чесно лишається null', () => {
    // DOU не показує сайт у списку. Домен доважується окремим запитом у fetch.
    expect(parseDou(frontend).every((row) => row.companyDomain === null)).toBe(true);
  });

  it('порожній html дає порожній список, а не падіння', () => {
    expect(parseDou('<html><body>нічого</body></html>')).toEqual([]);
  });

  it('категорії описані конфігом, а не зашиті в код', () => {
    expect(DOU_CATEGORIES).toContain('Front End');
    expect(DOU_CATEGORIES.length).toBeGreaterThan(1);
  });
});
