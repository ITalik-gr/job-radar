import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isFundingNews, parseAin, parseDevUa } from '../src/sources/leads/funding.js';

/** The AIN.ua investments section and the dev.ua RSS as saved on 2026-10-21, AIN cut to its main block. */
const ain = readFileSync('fixtures/ain/investments.html', 'utf8');
const devua = readFileSync('fixtures/devua/rss.xml', 'utf8');

describe('funding news filter', () => {
  it('takes rounds and investments, leaves funds closing and acquisitions', () => {
    expect(isFundingNews('Osavul залучила €8,5 млн у Series A для розвитку ШІ-платформи')).toBe(true);
    expect(isFundingNews('u.ventures інвестував у PixelCrew, новий ШІ-стартап')).toBe(true);
    expect(isFundingNews('Стартап отримав $2 млн seed-інвестицій')).toBe(true);
    expect(isFundingNews('Endeavor Catalyst закрив пʼятий фонд на $320 млн')).toBe(false);
    expect(isFundingNews('Superhuman придбала ШІ-асистента для зустрічей Fathom')).toBe(false);
    expect(isFundingNews('Apple провела вересневу презентацію')).toBe(false);
    expect(isFundingNews('Данські фонди Final Frontier і Myriad обʼєднуються: інвестуватимуть у стартапи')).toBe(false);
  });
});

describe('AIN.ua investments', () => {
  const leads = parseAin(ain);

  it('finds the funding news among the section articles', () => {
    expect(leads.length).toBeGreaterThanOrEqual(3);
    const titles = leads.map((lead) => lead.title);
    expect(titles.some((title) => title.startsWith('Osavul залучила'))).toBe(true);
    expect(titles.some((title) => title.startsWith('M-Fly залучила'))).toBe(true);
    expect(titles.some((title) => title.includes('Endeavor Catalyst'))).toBe(false);
  });

  it('a news lead has an absolute url as its id, a summary, and no company', () => {
    const osavul = leads.find((lead) => lead.title.startsWith('Osavul'))!;
    expect(osavul.url).toMatch(/^https:\/\/ain\.ua\/2026\/10\/01\//);
    expect(osavul.externalId).toBe(osavul.url);
    expect(osavul.text).toBeTruthy();
    expect(osavul).toMatchObject({ source: 'ain', company: null, contact: null, deadlineAt: null });
  });

  it('no duplicates when a page links the same article twice', () => {
    expect(new Set(leads.map((lead) => lead.url)).size).toBe(leads.length);
  });
});

describe('dev.ua RSS', () => {
  it('keeps only funding news about Ukrainian companies', () => {
    // The saved feed has one funding item, about a foreign startup: nothing passes.
    expect(parseDevUa(devua)).toEqual([]);

    const ukrainian = devua.replace(
      '<title>Рекламу в ChatGPT тепер можна запускати в Україні</title>',
      '<title>Український стартап Acme залучив $3 млн у раунді seed</title>',
    );
    const [lead] = parseDevUa(ukrainian);
    expect(lead).toMatchObject({ source: 'devua', company: null });
    expect(lead!.url).toMatch(/^https:\/\/dev\.ua\/news\//);
  });

  it('anything that is not RSS fails loudly', () => {
    expect(() => parseDevUa('<html><body>blocked</body></html>')).toThrow('not an RSS feed');
  });
});
