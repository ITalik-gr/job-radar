import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanHref, normalizePage, scrubText } from '../src/pipeline/normalize.js';
import { diffBlocks, diffByExternalId } from '../src/pipeline/diff.js';

const page = (name: string) => normalizePage(readFileSync(`fixtures/careers/${name}.html`, 'utf8'));

const v1 = page('acme-v1');
const noise = page('acme-v1-noise');
const v2 = page('acme-v2');

describe('scrubText', () => {
  it('strips relative time in two languages', () => {
    // The "Posted" label disappears along with the time, it adds nothing to the content.
    expect(scrubText('Posted 2 days ago')).toBe('');
    expect(scrubText('оновлено 3 дні тому')).toBe('оновлено');
    expect(scrubText('Just now')).toBe('');
  });

  it('strips absolute dates and time', () => {
    expect(scrubText('deployed 12.08.2026 14:32')).toBe('deployed');
    expect(scrubText('Last updated 12 August 2026')).toBe('last updated');
    expect(scrubText('2026-09-03T10:00:00Z build')).toBe('build');
  });

  it('strips view and applicant counters', () => {
    expect(scrubText('37 applicants')).toBe('');
    expect(scrubText('viewed 4821 times')).toBe('');
    expect(scrubText('12 people applied')).toBe('');
    expect(scrubText('148 переглядів')).toBe('');
  });

  it('strips random hashes but keeps ordinary words', () => {
    expect(scrubText('build a91f3c77de24b8e0f5c1 ok')).toBe('build ok');
    expect(scrubText('react typescript nestjs')).toBe('react typescript nestjs');
  });

  it('collapses whitespace and drops empty lines', () => {
    expect(scrubText('  a  \n\n\n  b  ')).toBe('a\nb');
  });
});

describe('cleanHref', () => {
  it('strips utm and ref from a relative link', () => {
    expect(cleanHref('/careers/dev?utm_source=x&ref=nav&id=3')).toBe('/careers/dev?id=3');
  });

  it('normalizes an absolute link', () => {
    expect(cleanHref('https://www.Acme.com/careers/dev/?gh_src=y')).toBe('https://acme.com/careers/dev');
  });

  it('drops anchors and javascript', () => {
    expect(cleanHref('#top')).toBeNull();
    expect(cleanHref('javascript:void(0)')).toBeNull();
    expect(cleanHref(undefined)).toBeNull();
  });
});

describe('normalizePage', () => {
  it('drops the consent banner, chat widget, footer and scripts', () => {
    expect(v1.text).not.toContain('cookie');
    expect(v1.text).not.toContain('chat with us');
    expect(v1.text).not.toContain('all rights reserved');
    expect(v1.text).not.toContain('window.__build__');
  });

  it('keeps the useful vacancy text', () => {
    expect(v1.text).toContain('senior frontend engineer');
    expect(v1.text).toContain('react, typescript, next.js');
  });

  it('finds vacancy blocks with clean links', () => {
    expect(v1.blocks).toHaveLength(4);
    expect(v1.blocks.map((b) => b.url)).toEqual([
      '/careers/senior-frontend-engineer',
      '/careers/nodejs-backend-engineer',
      '/careers/ui-ux-designer',
      '/careers/qa-automation-engineer',
    ]);
    expect(v1.blocks[0]!.title).toBe('senior frontend engineer');
  });

  it('the same content with different dates, counters and build hashes gives the same hash', () => {
    expect(noise.contentHash).toBe(v1.contentHash);
    expect(noise.blocks.map((b) => b.hash)).toEqual(v1.blocks.map((b) => b.hash));
  });

  it('a real change changes the hash', () => {
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });
});

describe('diffBlocks', () => {
  it('a noisy version gives no changes at all', () => {
    const diff = diffBlocks(
      v1.blocks.map((b) => b.hash),
      noise.blocks,
    );
    expect(diff.changed).toBe(false);
    expect(diff.unchanged).toBe(4);
  });

  it('sees exactly one new and one missing vacancy', () => {
    const diff = diffBlocks(
      v1.blocks.map((b) => b.hash),
      v2.blocks,
    );
    expect(diff.added.map((b) => b.url)).toEqual(['/careers/full-stack-engineer-ai']);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toBe(v1.blocks.find((b) => b.url === '/careers/ui-ux-designer')!.hash);
    expect(diff.unchanged).toBe(3);
    expect(diff.changed).toBe(true);
  });

  it('the first pass gives every block as new', () => {
    const diff = diffBlocks([], v1.blocks);
    expect(diff.added).toHaveLength(4);
    expect(diff.removed).toHaveLength(0);
  });
});

describe('diffByExternalId', () => {
  const items = [
    { externalId: '1', url: 'https://acme.com/jobs/1' },
    { externalId: '2', url: 'https://acme.com/jobs/2' },
  ];

  it('new ids are new vacancies, missing ones are closed', () => {
    const diff = diffByExternalId(['1', '9'], items);
    expect(diff.added.map((i) => i.externalId)).toEqual(['2']);
    expect(diff.removed).toEqual(['9']);
    expect(diff.unchanged).toBe(1);
  });

  it('nothing moves when nothing changed', () => {
    expect(diffByExternalId(['1', '2'], items).changed).toBe(false);
  });

  it('falls back to url when the source gave no id', () => {
    const diff = diffByExternalId(['https://acme.com/jobs/3'], [
      { externalId: null, url: 'https://acme.com/jobs/3' },
    ]);
    expect(diff.changed).toBe(false);
  });

  it('duplicates in one response are counted once', () => {
    const diff = diffByExternalId([], [...items, items[0]!]);
    expect(diff.added).toHaveLength(2);
  });
});

/*
 * Pairs that differ only in noise must scrub to the same text. Found by the audit: each of
 * these used to change the page hash between two fetches.
 */
describe('noise that used to leak into the hash', () => {
  const same = (a: string, b: string) => expect(scrubText(a)).toBe(scrubText(b));

  it('applicant phrases and counters with a k suffix', () => {
    same('Be among the first 25 applicants', 'Over 100 applicants');
    same('1.2k views', '1.4k views');
    same('Переглядів: 120', 'Переглядів: 131');
  });

  it('Ukrainian dates with a month name and countdown deadlines', () => {
    same('24 вересня 2026', '25 вересня 2026');
    same('Closes in 5 days', 'Closes in 4 days');
  });

  it('text of sibling blocks is not glued, so relative time still gets stripped', () => {
    const page = (days: number) =>
      `<body><ul><li><a href="/jobs/1">Frontend Engineer</a> posted ${days} days ago</li></ul><div>Apply</div></body>`;
    expect(normalizePage(page(3)).contentHash).toBe(normalizePage(page(5)).contentHash);
  });

  it('Lever tracking parameters are dropped from links', () => {
    expect(cleanHref('https://x.com/jobs/1?lever-source=li&trk=a')).toBe('https://x.com/jobs/1');
  });
});
