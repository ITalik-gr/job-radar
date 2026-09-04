import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DJINNI_KEYWORDS, parseDjinni } from '../src/sources/boards/djinni.js';

const javascript = readFileSync('fixtures/djinni/jobs-javascript.html', 'utf8');
const fullstack = readFileSync('fixtures/djinni/jobs-fullstack.html', 'utf8');

describe('djinni', () => {
  it('розбирає сторінку пошуку і не повертає нуль', () => {
    // Правило 3 в CLAUDE.md: порожній результат це помилка, не успіх.
    expect(parseDjinni(javascript).length).toBeGreaterThan(5);
    expect(parseDjinni(fullstack).length).toBeGreaterThan(5);
  });

  it('бере назву, посилання і зовнішній id', () => {
    const row = parseDjinni(javascript)[0]!;

    expect(row.source).toBe('djinni');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/djinni\.co\/jobs\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
  });

  it('бере назву компанії, коли вона не прихована', () => {
    expect(parseDjinni(javascript).some((row) => row.companyName)).toBe(true);
  });

  it('українське "тільки віддалено" читається як remote', () => {
    const rows = parseDjinni(javascript);
    const remote = rows.find((row) => /тільки віддалено/i.test(row.rawText));

    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
  });

  it('число замість назви компанії це не компанія', () => {
    // В анонімних вакансіях на цьому місці стоїть лічильник переглядів.
    for (const row of parseDjinni(javascript).concat(parseDjinni(fullstack))) {
      if (row.companyName) expect(row.companyName).not.toMatch(/^\d+$/);
    }
  });

  it('домен компанії лишається null: Djinni не веде на сайт роботодавця', () => {
    // Вигадувати домен з адреси борду не можна, це склеїло б усі вакансії в одну компанію.
    expect(parseDjinni(javascript).every((row) => row.companyDomain === null)).toBe(true);
  });

  it('текст картки потрапляє в rawText, бо вилки окремим полем немає', () => {
    for (const row of parseDjinni(javascript)) {
      expect(row.rawText.length).toBeGreaterThan(row.title!.length);
    }
  });

  it('порожній html дає порожній список, а не падіння', () => {
    expect(parseDjinni('<html><body>нічого</body></html>')).toEqual([]);
  });

  it('ключові слова описані конфігом, а не зашиті в код', () => {
    expect(DJINNI_KEYWORDS).toContain('JavaScript');
    expect(DJINNI_KEYWORDS.length).toBeGreaterThan(1);
  });
});
