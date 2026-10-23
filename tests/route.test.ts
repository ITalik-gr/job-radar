import { describe, expect, it } from 'vitest';
import { companyHref, href, hrefWith, ownsAddress, parse, parseQuery } from '../web/src/lib/route';
import { filterFromParams, filterParams, type CompanyFilter } from '../web/src/lib/filterParams';

/**
 * Page addresses. A small thing that decides whether a link to a company from a draft
 * and from the outreach history opens, so edge cases are checked here, not in the
 * browser: a domain can contain dots, and a hash can be anything.
 */

describe('address parsing', () => {
  it('an empty hash means the start section', () => {
    expect(parse('')).toEqual([]);
    expect(parse('#')).toEqual([]);
    expect(parse('#/')).toEqual([]);
  });

  it('reads the section and the company', () => {
    expect(parse('#/companies')).toEqual(['companies']);
    expect(parse('#/companies/acme.com')).toEqual(['companies', 'acme.com']);
  });

  it('extra slashes do not create empty segments', () => {
    expect(parse('#//companies//acme.com/')).toEqual(['companies', 'acme.com']);
  });

  /*
   * The hash gets hand-edited in the address bar more often than it seems, and broken
   * percent-encoding must not give a blank screen instead of a page.
   */
  it('a broken address does not break parsing', () => {
    expect(parse('#/companies/%E0%A4%A')).toEqual(['companies', '%E0%A4%A']);
  });

  it('builds the address back in the same shape', () => {
    expect(href('companies', 'acme.com')).toBe('#/companies/acme.com');
    expect(companyHref('acme.com')).toBe('#/companies/acme.com');
    expect(parse(companyHref('sub.domain.co.uk'))).toEqual(['companies', 'sub.domain.co.uk']);
  });
});

/*
 * The bug this guards: after a click on another section the list page rendered once more and
 * wrote its own card back into the address, so the navigation never moved.
 */
describe('who may write the selection', () => {
  it('a page owns its own section', () => {
    expect(ownsAddress('#/studios/acme.com', 'studios')).toBe(true);
    expect(ownsAddress('#/studios', 'studios')).toBe(true);
  });

  it('a page does not own an address that already moved to another section', () => {
    expect(ownsAddress('#/companies', 'studios')).toBe(false);
    expect(ownsAddress('#/templates/pitch', 'studios')).toBe(false);
  });

  it('an empty address belongs to whoever is open by default', () => {
    expect(ownsAddress('', 'studios')).toBe(true);
    expect(ownsAddress('#/', 'studios')).toBe(true);
  });
});

/*
 * List state lives after a `?` in the hash, so going back to a list restores its filters. The
 * path must ignore it, or `#/studios?mode=all` would read as a section named `studios?mode=all`.
 */
describe('list state in the address', () => {
  it('the path ignores the query', () => {
    expect(parse('#/studios?country=UA')).toEqual(['studios']);
    expect(parse('#/companies/acme.com?x=1')).toEqual(['companies', 'acme.com']);
  });

  it('reads and writes the query, dropping empty values', () => {
    expect(parseQuery('#/studios?country=UA&mode=all')).toEqual({ country: 'UA', mode: 'all' });
    expect(parseQuery('#/studios')).toEqual({});
    expect(hrefWith(['studios'], { country: 'UA', q: '', mode: undefined })).toBe('#/studios?country=UA');
    expect(hrefWith(['studios'], {})).toBe('#/studios');
  });

  it('a value with spaces and commas survives the round trip', () => {
    const target = hrefWith(['companies'], { q: 'web design, kyiv' });
    expect(parseQuery(target)).toEqual({ q: 'web design, kyiv' });
  });
});

describe('a company filter in the address', () => {
  it('survives the round trip through URL parameters', () => {
    const filter: CompanyFilter = {
      search: 'dental',
      kind: ['smb', 'ecommerce'],
      hasEmail: true,
      hiring: false,
      minScore: 5,
      country: 'UA',
    };
    expect(filterFromParams(filterParams(filter))).toEqual(filter);
  });

  it('ignores what is not the filter', () => {
    expect(filterFromParams({ sort: 'name', minScore: 'abc', market: 'ua' })).toEqual({ market: 'ua' });
  });
});
