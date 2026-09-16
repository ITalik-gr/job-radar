import { describe, expect, it } from 'vitest';
import { companyHref, href, parse } from '../web/src/lib/route';

/**
 * Адреси сторінок. Дрібниця, від якої залежить, чи відкриється посилання на
 * контору з чернетки і з історії листування, тому крайні випадки перевіряються
 * тут, а не в браузері: домен може містити крапки, а хеш може бути будь-яким.
 */

describe('розбір адреси', () => {
  it('порожній хеш означає стартовий розділ', () => {
    expect(parse('')).toEqual([]);
    expect(parse('#')).toEqual([]);
    expect(parse('#/')).toEqual([]);
  });

  it('читає розділ і компанію', () => {
    expect(parse('#/companies')).toEqual(['companies']);
    expect(parse('#/companies/acme.com')).toEqual(['companies', 'acme.com']);
  });

  it('зайві слеші не створюють порожніх сегментів', () => {
    expect(parse('#//companies//acme.com/')).toEqual(['companies', 'acme.com']);
  });

  /*
   * Хеш правиться руками в адресному рядку частіше, ніж здається, і побитий
   * percent-encoding не має давати білий екран замість сторінки.
   */
  it('побита адреса не валить розбір', () => {
    expect(parse('#/companies/%E0%A4%A')).toEqual(['companies', '%E0%A4%A']);
  });

  it('збирає адресу назад тим самим виглядом', () => {
    expect(href('companies', 'acme.com')).toBe('#/companies/acme.com');
    expect(companyHref('acme.com')).toBe('#/companies/acme.com');
    expect(parse(companyHref('sub.domain.co.uk'))).toEqual(['companies', 'sub.domain.co.uk']);
  });
});
