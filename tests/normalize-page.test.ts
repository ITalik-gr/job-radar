import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanHref, normalizePage, scrubText } from '../src/pipeline/normalize.js';
import { diffBlocks, diffByExternalId } from '../src/pipeline/diff.js';

const page = (name: string) => normalizePage(readFileSync(`fixtures/careers/${name}.html`, 'utf8'));

const v1 = page('acme-v1');
const noise = page('acme-v1-noise');
const v2 = page('acme-v2');

describe('scrubText', () => {
  it('прибирає відносний час двома мовами', () => {
    // Мітка "Posted" зникає разом із часом, вона нічого не додає до змісту.
    expect(scrubText('Posted 2 days ago')).toBe('');
    expect(scrubText('оновлено 3 дні тому')).toBe('оновлено');
    expect(scrubText('Just now')).toBe('');
  });

  it('прибирає абсолютні дати і час', () => {
    expect(scrubText('deployed 12.08.2026 14:32')).toBe('deployed');
    expect(scrubText('Last updated 12 August 2026')).toBe('last updated');
    expect(scrubText('2026-09-03T10:00:00Z build')).toBe('build');
  });

  it('прибирає лічильники переглядів і кандидатів', () => {
    expect(scrubText('37 applicants')).toBe('');
    expect(scrubText('viewed 4821 times')).toBe('');
    expect(scrubText('12 people applied')).toBe('');
    expect(scrubText('148 переглядів')).toBe('');
  });

  it('прибирає випадкові хеші, але лишає звичайні слова', () => {
    expect(scrubText('build a91f3c77de24b8e0f5c1 ok')).toBe('build ok');
    expect(scrubText('react typescript nestjs')).toBe('react typescript nestjs');
  });

  it('схлопує пробіли і викидає порожні рядки', () => {
    expect(scrubText('  a  \n\n\n  b  ')).toBe('a\nb');
  });
});

describe('cleanHref', () => {
  it('прибирає utm і ref з відносного посилання', () => {
    expect(cleanHref('/careers/dev?utm_source=x&ref=nav&id=3')).toBe('/careers/dev?id=3');
  });

  it('нормалізує абсолютне посилання', () => {
    expect(cleanHref('https://www.Acme.com/careers/dev/?gh_src=y')).toBe('https://acme.com/careers/dev');
  });

  it('відкидає якорі і javascript', () => {
    expect(cleanHref('#top')).toBeNull();
    expect(cleanHref('javascript:void(0)')).toBeNull();
    expect(cleanHref(undefined)).toBeNull();
  });
});

describe('normalizePage', () => {
  it('викидає банер згоди, чат-віджет, футер і скрипти', () => {
    expect(v1.text).not.toContain('cookie');
    expect(v1.text).not.toContain('chat with us');
    expect(v1.text).not.toContain('all rights reserved');
    expect(v1.text).not.toContain('window.__build__');
  });

  it('лишає корисний текст вакансій', () => {
    expect(v1.text).toContain('senior frontend engineer');
    expect(v1.text).toContain('react, typescript, next.js');
  });

  it('знаходить блоки вакансій з чистими посиланнями', () => {
    expect(v1.blocks).toHaveLength(4);
    expect(v1.blocks.map((b) => b.url)).toEqual([
      '/careers/senior-frontend-engineer',
      '/careers/nodejs-backend-engineer',
      '/careers/ui-ux-designer',
      '/careers/qa-automation-engineer',
    ]);
    expect(v1.blocks[0]!.title).toBe('senior frontend engineer');
  });

  it('те саме наповнення з іншими датами, лічильниками і білд-хешами дає той самий хеш', () => {
    expect(noise.contentHash).toBe(v1.contentHash);
    expect(noise.blocks.map((b) => b.hash)).toEqual(v1.blocks.map((b) => b.hash));
  });

  it('реальна зміна змінює хеш', () => {
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });
});

describe('diffBlocks', () => {
  it('шумова версія не дає жодної зміни', () => {
    const diff = diffBlocks(
      v1.blocks.map((b) => b.hash),
      noise.blocks,
    );
    expect(diff.changed).toBe(false);
    expect(diff.unchanged).toBe(4);
  });

  it('бачить рівно одну нову і одну зниклу вакансію', () => {
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

  it('перший обхід дає всі блоки як нові', () => {
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

  it('нові id це нові вакансії, зниклі це закриті', () => {
    const diff = diffByExternalId(['1', '9'], items);
    expect(diff.added.map((i) => i.externalId)).toEqual(['2']);
    expect(diff.removed).toEqual(['9']);
    expect(diff.unchanged).toBe(1);
  });

  it('без змін нічого не рухається', () => {
    expect(diffByExternalId(['1', '2'], items).changed).toBe(false);
  });

  it('падає назад на url, якщо джерело не дало id', () => {
    const diff = diffByExternalId(['https://acme.com/jobs/3'], [
      { externalId: null, url: 'https://acme.com/jobs/3' },
    ]);
    expect(diff.changed).toBe(false);
  });

  it('дублі в одній відповіді рахуються один раз', () => {
    const diff = diffByExternalId([], [...items, items[0]!]);
    expect(diff.added).toHaveLength(2);
  });
});
