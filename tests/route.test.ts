import { describe, expect, it } from 'vitest';
import { companyHref, href, ownsAddress, parse } from '../web/src/lib/route';

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
