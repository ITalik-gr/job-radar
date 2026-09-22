import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_PROSE_CHARS, isUsefulDetail, jobTextFromNextData, proseChars } from '../src/lib/detail.js';
import { anyToText } from '../src/lib/html.js';

/**
 * The fixtures are two real texts from the database: the Techstars page, where the HTML
 * holds only the network menu, and the Getro page with a real description. It was the
 * first one where the radar stored "startups, corporations, communities" as the vacancy
 * description.
 */
const nav = readFileSync('fixtures/detail/techstars-nav.txt', 'utf8');
const job = readFileSync('fixtures/detail/getro-job.txt', 'utf8');

const techstars = readFileSync('fixtures/detail/techstars-job.html', 'utf8');

describe('description from __NEXT_DATA__', () => {
  it('extracts the vacancy text where the markup holds only the network menu', () => {
    const text = anyToText(jobTextFromNextData(techstars)!);
    expect(text).toContain('Product Engineer');
    expect(text).toContain('end-to-end ownership');
    expect(isUsefulDetail(text)).toBe(true);
  });

  it('the network menu does not end up in the text', () => {
    const text = jobTextFromNextData(techstars)!;
    expect(text).not.toContain('cd_wrapper');
    expect(text.length).toBeLessThan(6000);
  });

  it('a page without next-data is simply null, not an exception', () => {
    expect(jobTextFromNextData('<html><body>nothing</body></html>')).toBeNull();
    expect(jobTextFromNextData('<script id="__NEXT_DATA__">{broken</script>')).toBeNull();
  });
});

describe('whether the text contains a vacancy description', () => {

  it('a real vacancy passes despite the same menu at the start', () => {
    expect(isUsefulDetail(job)).toBe(true);
    expect(proseChars(job)).toBeGreaterThan(MIN_PROSE_CHARS);
  });

  it('empty text is not a description', () => {
    expect(isUsefulDetail('')).toBe(false);
    expect(isUsefulDetail(null)).toBe(false);
  });

  it('two real sentences are already enough', () => {
    const text = [
      'We are looking for a front-end engineer to join our small product team in Kyiv.',
      'You will work with React, TypeScript and Node, shipping features end to end every week.',
      'Experience with Next.js and Postgres is a plus, but we care more about how you think.',
      'The role is remote friendly and we cover a co-working space if you prefer an office.',
    ].join('\n');
    expect(isUsefulDetail(text)).toBe(true);
  });

  it('a list of short bullet points is not a description yet', () => {
    const menu = ['startups', 'corporations', 'communities', 'investors', 'mission'].join('\n');
    expect(proseChars(menu)).toBe(0);
  });
});
