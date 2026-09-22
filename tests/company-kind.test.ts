import { describe, expect, it } from 'vitest';
import { detectKind } from '../src/pipeline/company-kind.js';

const base = { tags: [], sources: [], description: null, sizeHint: null };

describe('company kind', () => {
  it('a startup source outweighs any tags', () => {
    expect(detectKind({ ...base, sources: ['getro'], tags: ['Web Development'] })).toBe('startup');
    expect(detectKind({ ...base, sources: ['yc'] })).toBe('startup');
  });

  it('a majority of design tags gives design', () => {
    expect(
      detectKind({ ...base, sources: ['clutch'], tags: ['Web Design', 'UI/UX Design', 'Branding'] }),
    ).toBe('design');
  });

  it('a majority of development tags gives studio', () => {
    expect(
      detectKind({
        ...base,
        sources: ['clutch'],
        tags: ['Web Development', 'Custom Software Development', 'Web Design'],
      }),
    ).toBe('studio');
  });

  it('an equal number of tags gives studio, because development is broader', () => {
    expect(detectKind({ ...base, sources: ['clutch'], tags: ['Web Design', 'Web Development'] })).toBe('studio');
  });

  it('outstaff is set apart, there is no point writing there', () => {
    expect(detectKind({ ...base, sources: ['clutch'], tags: ['IT Staff Augmentation'] })).toBe('outstaff');
  });

  it('one outstaff tag among development tags does not make the company outstaff', () => {
    expect(
      detectKind({
        ...base,
        sources: ['clutch'],
        tags: ['Web Development', 'Custom Software Development', 'IT Staff Augmentation'],
      }),
    ).toBe('studio');
  });

  it('a company from an ATS source without catalog tags is a product', () => {
    expect(detectKind({ ...base, sources: ['greenhouse'] })).toBe('product');
    expect(detectKind({ ...base, sources: ['rss:remotive'] })).toBe('product');
  });

  it('its own ATS without catalog tags is a product company', () => {
    // Vercel and Stripe came from the CSV seed, by source label alone they would stay unknown
    // and show up under Studios, where a cold letter would be pointless.
    expect(detectKind({ ...base, sources: ['csv'], careersKind: 'greenhouse' })).toBe('product');
    expect(detectKind({ ...base, sources: ['csv'], careersKind: 'ashby' })).toBe('product');
  });

  it('the ATS does not override catalog tags: a studio can also have greenhouse', () => {
    expect(
      detectKind({ ...base, sources: ['clutch'], tags: ['Web Development'], careersKind: 'greenhouse' }),
    ).toBe('studio');
  });

  it('an agency catalog without tags is still a studio', () => {
    expect(detectKind({ ...base, sources: ['designrush'] })).toBe('studio');
  });

  it('the description helps when there are no tags and no familiar sources', () => {
    expect(detectKind({ ...base, description: 'We are a web design studio from Kyiv' })).toBe('studio');
  });

  it('an empty card is unknown, not a guess', () => {
    expect(detectKind(base)).toBe('unknown');
  });
});
