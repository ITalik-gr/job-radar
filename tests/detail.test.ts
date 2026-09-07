import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_PROSE_CHARS, isUsefulDetail, jobTextFromNextData, proseChars } from '../src/lib/detail.js';
import { anyToText } from '../src/lib/html.js';

/**
 * Фікстури це два справжні тексти з бази: сторінка Techstars, де в HTML лежить
 * саме меню, і сторінка Getro з реальним описом. Саме на першій радар зберігав
 * "startups, corporations, communities" як опис вакансії.
 */
const nav = readFileSync('fixtures/detail/techstars-nav.txt', 'utf8');
const job = readFileSync('fixtures/detail/getro-job.txt', 'utf8');

const techstars = readFileSync('fixtures/detail/techstars-job.html', 'utf8');

describe('опис із __NEXT_DATA__', () => {
  it('дістає текст вакансії там, де в розмітці лише меню мережі', () => {
    const text = anyToText(jobTextFromNextData(techstars)!);
    expect(text).toContain('Product Engineer');
    expect(text).toContain('end-to-end ownership');
    expect(isUsefulDetail(text)).toBe(true);
  });

  it('меню мережі в текст не потрапляє', () => {
    const text = jobTextFromNextData(techstars)!;
    expect(text).not.toContain('cd_wrapper');
    expect(text.length).toBeLessThan(6000);
  });

  it('сторінка без next-data це просто null, а не виняток', () => {
    expect(jobTextFromNextData('<html><body>нічого</body></html>')).toBeNull();
    expect(jobTextFromNextData('<script id="__NEXT_DATA__">{зламаний</script>')).toBeNull();
  });
});

describe('чи є в тексті опис вакансії', () => {

  it('справжня вакансія проходить, попри те саме меню на початку', () => {
    expect(isUsefulDetail(job)).toBe(true);
    expect(proseChars(job)).toBeGreaterThan(MIN_PROSE_CHARS);
  });

  it('порожній текст це не опис', () => {
    expect(isUsefulDetail('')).toBe(false);
    expect(isUsefulDetail(null)).toBe(false);
  });

  it('два справжні речення вже достатньо', () => {
    const text = [
      'We are looking for a front-end engineer to join our small product team in Kyiv.',
      'You will work with React, TypeScript and Node, shipping features end to end every week.',
      'Experience with Next.js and Postgres is a plus, but we care more about how you think.',
      'The role is remote friendly and we cover a co-working space if you prefer an office.',
    ].join('\n');
    expect(isUsefulDetail(text)).toBe(true);
  });

  it('список коротких пунктів це ще не опис', () => {
    const menu = ['startups', 'corporations', 'communities', 'investors', 'mission'].join('\n');
    expect(proseChars(menu)).toBe(0);
  });
});
